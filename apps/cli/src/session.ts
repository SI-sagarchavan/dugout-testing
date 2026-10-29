import type { ApprovalDecision, ApprovalRequest, RunEvent } from "@dugout/contracts";
import type { AnyAgent } from "@dugout/sdk";
import { endsInvocation, type RunQueue } from "@dugout/worker";

/** Where a session reads answers and writes what happens. */
export interface Terminal {
  /** Writes text as it comes (streamed model text). */
  write(text: string): void;
  /** Writes a line. */
  line(text: string): void;
  /** Shows a prompt and returns the answer, trimmed; "" when input has ended. */
  ask(prompt: string): Promise<string>;
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
  signal: AbortSignal;
  /** How long to wait for a worker before saying none has picked the run up. */
  hintMs?: number;
}

/** The event a run ended with. */
export type Ending = Extract<RunEvent, { type: "run.completed" | "run.failed" }>;

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const clip = (s: string, max = 100) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const presentAsJson = (req: Pick<ApprovalRequest, "tool" | "input">) =>
  `── ${req.tool} ──\n${JSON.stringify(req.input, null, 2)}`;

/**
 * Follows a run as a host does (ADR 0009): its events stream from Valkey as a worker writes them.
 * At an approval it shows the request and asks: `y` approves, `n` rejects (with a reason), anything
 * else is a change request that goes back to the agent in the same run (ADR 0005). The decision is
 * queued and a worker resumes the run. Returns how the run ended, or undefined if `signal` aborted.
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
    terminal.line(`\n\n${present(last.data)}`);
    const decision = await askDecision(terminal, opts.by);
    if ((await queue.decide(tenantId, runId, last.data.callId, decision)) === undefined) {
      terminal.line(dim("· this approval was already decided elsewhere"));
    }
  }
}

async function askDecision(terminal: Terminal, by: string): Promise<ApprovalDecision> {
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

/** Shows a run's events; streamed text as it comes, the rest as dim notes on lines of their own. */
function shower(terminal: Terminal) {
  let midLine = false;
  const note = (text: string) => {
    if (midLine) terminal.write("\n");
    midLine = false;
    terminal.line(dim(text));
  };
  return (e: RunEvent) => {
    if (e.type === "token") {
      terminal.write(e.data.text);
      midLine = !e.data.text.endsWith("\n");
    } else if (e.type === "context.built") {
      const kinds = e.data.sources.map((s) => s.kind).join(", ") || "none";
      note(`· memory: ${kinds} (${e.data.tokens} tokens)`);
    } else if (e.type === "run.resumed") note(`· resumed by a worker (${e.data.reason})`);
    else if (e.type === "tool.started") {
      const input = JSON.stringify(e.data.input);
      note(`· ${e.data.tool}${input && input !== "{}" ? ` ${clip(input)}` : ""}`);
    } else if (e.type === "tool.denied") note(`· denied ${e.data.tool}: ${e.data.reason}`);
    else if (e.type === "tool.completed" && !e.data.ok)
      note(`· ${e.data.tool} failed: ${e.data.content}`);
    else if (e.type === "approval.changes_requested")
      note(`· sent back for changes: ${e.data.changes}`);
    else if (e.type === "approval.requested" && midLine) {
      terminal.write("\n");
      midLine = false;
    }
  };
}
