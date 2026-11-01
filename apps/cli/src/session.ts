import {
  type ApprovalDecision,
  type ApprovalRequest,
  AUTO_APPROVED,
  type RunEvent,
} from "@dugout/contracts";
import type { AnyAgent } from "@dugout/sdk";
import { endsInvocation, type RunQueue } from "@dugout/worker";
import pc from "picocolors";

/** Where a session reads answers and writes what happens. */
export interface Terminal {
  /** Writes text as it comes (streamed model text). */
  write(text: string): void;
  /** Writes a line. */
  line(text: string): void;
  /** Shows a prompt and returns the answer, trimmed; "" when input has ended. */
  ask(prompt: string): Promise<string>;
  /**
   * Offers a fixed set of answers. When this is set, an approval is a menu.
   * Without it, the session asks for `y`, `n`, or the change as text, which is what a pipe sends.
   */
  choose?(
    message: string,
    options: readonly { value: string; label: string; hint?: string }[],
  ): Promise<string>;
  /** Shows a block the reviewer reads, such as a draft, when the terminal can draw one. */
  panel?(text: string): void;
}

export interface SessionOptions {
  queue: RunQueue;
  agent: Pick<AnyAgent, "cli">;
  tenantId: string;
  runId: string;
  /** Show the run's events after this `seq`; 0 shows them all. */
  afterSeq?: number;
  terminal: Terminal;
  /** Who decides the approvals. */
  by: string;
  /**
   * Approves each approval request itself, without asking. The request stays in the run's events
   * and the decision is recorded as made by `by` (auto), so a run can be traced to who chose this.
   */
  autoApprove?: boolean;
  signal: AbortSignal;
  /** How long to wait for a worker before saying none has picked the run up. */
  hintMs?: number;
}

/** The event a run ended with. */
export type Ending = Extract<RunEvent, { type: "run.completed" | "run.failed" | "run.cancelled" }>;

export const dim = (s: string) => pc.dim(s);
const clip = (s: string, max = 100) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const presentAsJson = (req: Pick<ApprovalRequest, "tool" | "input">) =>
  `── ${req.tool} ──\n${JSON.stringify(req.input, null, 2)}`;

/**
 * Follows a run as a host does (ADR 0009): its events stream from Valkey as a worker writes them.
 * At an approval it shows the request and asks. A terminal with `choose` gets a menu: approve,
 * reject, or request a change. Anything else is asked as text: `y` approves, `n` rejects (with a
 * reason), and the rest is a change request that goes back to the agent in the same run (ADR 0005).
 * The decision is queued and a worker resumes the run. Returns how the run ended, or undefined if
 * `signal` aborted.
 */
export async function followRun(opts: SessionOptions): Promise<Ending | undefined> {
  const { queue, tenantId, runId, terminal } = opts;
  const show = shower(terminal);
  const present = opts.agent.cli.present ?? presentAsJson;
  let after = opts.afterSeq ?? 0;
  for (;;) {
    let last: RunEvent | undefined;
    const hint = setTimeout(
      () => terminal.line(dim("· no worker has picked the run up yet; start one: pnpm worker")),
      opts.hintMs ?? 5_000,
    );
    try {
      for await (const e of queue.follow(tenantId, runId, after, opts.signal, endsInvocation)) {
        clearTimeout(hint);
        show(e);
        after = e.seq;
        last = e;
      }
    } finally {
      clearTimeout(hint);
    }
    if (!last || !endsInvocation(last)) return undefined;
    if (last.type !== "approval.requested") return last;
    // an approval replayed from earlier in the run was decided already: carry on past it
    if ((await queue.waitingFor(tenantId, runId)) !== last.data.callId) continue;
    const shown = present(last.data);
    if (opts.autoApprove) {
      terminal.line(dim(`· approved without asking: ${last.data.tool}`));
      const auto = { approved: true as const, by: `${opts.by}${AUTO_APPROVED}` };
      if ((await queue.decide(tenantId, runId, last.data.callId, auto)) === undefined) {
        terminal.line(dim("· this approval was already decided elsewhere"));
      }
      continue;
    }
    if (terminal.panel) terminal.panel(shown);
    else terminal.line(`\n\n${shown}`);
    const decision = await askDecision(terminal, opts.by);
    if ((await queue.decide(tenantId, runId, last.data.callId, decision)) === undefined) {
      terminal.line(dim("· this approval was already decided elsewhere"));
    }
  }
}

async function askDecision(terminal: Terminal, by: string): Promise<ApprovalDecision> {
  if (terminal.choose) return askChoice(terminal, by);
  for (;;) {
    const answer = await terminal.ask(
      `\n${dim("y approve · n reject · or type the change you want")}\n> `,
    );
    if (/^(y|yes)$/i.test(answer)) return { approved: true, by };
    if (/^(n|no)?$/i.test(answer)) {
      const reason = (await terminal.ask("Reason for rejecting: ")) || "no reason given";
      return { approved: false, by, reason };
    }
    const changes = answer.replace(/^change:\s*/i, "");
    if (changes) return { approved: false, by, changes };
    terminal.line("Type the change you want, or y to approve, n to reject.");
  }
}

/** Approve, reject, or send a change back, as a menu. */
async function askChoice(terminal: Terminal, by: string): Promise<ApprovalDecision> {
  for (;;) {
    const choice = await terminal.choose?.("This step needs a decision", [
      { value: "approve", label: "Approve", hint: "let the agent continue" },
      { value: "reject", label: "Reject", hint: "stop, and say why" },
      { value: "change", label: "Request a change", hint: "send it back in this run" },
    ]);
    if (choice === "approve") return { approved: true, by };
    if (choice === "reject") {
      const reason = (await terminal.ask("Reason for rejecting")) || "no reason given";
      return { approved: false, by, reason };
    }
    if (choice === "change") {
      const changes = await terminal.ask("What should change?");
      if (changes) return { approved: false, by, changes };
      terminal.line("Say what should change, or pick another decision.");
      continue;
    }
    terminal.line("Pick a decision.");
  }
}

/** How much of a tool call to keep on the one live line while the model writes it. */
const LIVE_TAIL = 64;

/** Shows a run's events; streamed text as it comes, the rest as dim notes on lines of their own. */
export function shower(terminal: Terminal) {
  let midLine = false;
  // The model writes a tool call for a long time before tool.started. That call's text stays on
  // one line and the tail moves, instead of the terminal sitting still until the call is done.
  let liveTool = "";
  let liveCall = "";
  let liveText = "";
  // Calls already on a line of their own, which tool.started doesn't print again.
  const streamed = new Set<string>();
  let liveDrawn = false;
  const finishLive = () => {
    if (!liveDrawn) return;
    terminal.write("\n");
    liveTool = "";
    liveCall = "";
    liveText = "";
    liveDrawn = false;
    midLine = false;
  };
  const note = (text: string, tone: "dim" | "warn" | "bad" = "dim") => {
    finishLive();
    if (midLine) terminal.write("\n");
    midLine = false;
    const paint = tone === "bad" ? pc.red : tone === "warn" ? pc.yellow : dim;
    terminal.line(paint(text));
  };
  const drawLive = (tool: string, text: string, redraw: boolean) => {
    const flat = text.replace(/\s+/g, " ");
    const tail = flat.length > LIVE_TAIL ? `…${flat.slice(-(LIVE_TAIL - 1))}` : flat;
    const line = dim(`· ${tool}  ${tail}`);
    terminal.write(redraw ? `\r\x1b[K${line}` : line);
    liveDrawn = true;
    midLine = true;
  };
  return (e: RunEvent) => {
    if (e.type === "token") {
      finishLive();
      terminal.write(e.data.text);
      midLine = !e.data.text.endsWith("\n");
    } else if (e.type === "tool.input.delta") {
      // A turn can make several calls, and each gets its own line.
      if (liveCall && liveCall !== e.data.callId) finishLive();
      liveTool = e.data.tool;
      liveCall = e.data.callId;
      liveText += e.data.text;
      // `{}` is card.figma and the other calls with no arguments. Leave those to tool.started.
      if (liveText === "{}") {
        liveTool = "";
        liveCall = "";
        liveText = "";
        return;
      }
      streamed.add(e.data.callId);
      drawLive(liveTool, liveText, liveDrawn);
    } else if (e.type === "context.built") {
      const count = e.data.sources.length;
      const items = count === 0 ? "none" : count === 1 ? "1 item" : `${count} items`;
      note(`· memory  ${items}  ${e.data.tokens} tokens`);
      for (const source of e.data.sources) {
        const label = (source.text ?? source.id).replace(/\s+/g, " ").trim();
        note(`  ${source.kind.padEnd(11)} ${String(source.tokens).padStart(4)}  ${label}`);
      }
    } else if (e.type === "run.resumed") note(`· resumed by a worker (${e.data.reason})`);
    else if (e.type === "tool.started") {
      // The call already streamed onto its line. Don't print the same JSON again, clipped.
      if (streamed.delete(e.data.callId)) {
        finishLive();
      } else {
        const input = JSON.stringify(e.data.input);
        note(`· ${e.data.tool}${input && input !== "{}" ? ` ${clip(input)}` : ""}`);
      }
    } else if (e.type === "tool.denied") note(`· denied ${e.data.tool}: ${e.data.reason}`, "warn");
    else if (e.type === "final.refused") note(`· final refused: ${e.data.reason}`, "warn");
    else if (e.type === "tool.completed" && !e.data.ok)
      note(`· ${e.data.tool} failed: ${e.data.content}`, "bad");
    else if (e.type === "approval.changes_requested")
      note(`· sent back for changes: ${e.data.changes}`);
    else if (e.type === "approval.requested") {
      finishLive();
      if (midLine) {
        terminal.write("\n");
        midLine = false;
      }
    }
  };
}
