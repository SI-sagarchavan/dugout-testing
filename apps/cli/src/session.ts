import {
  type Answer,
  type Answers,
  type AskedQuestion,
  AUTO_APPROVED,
  type Decision,
  type InterruptRequest,
  invalidAnswer,
  proposedAnswers,
  proposedValue,
  REVIEW_ID,
  type ReviewAnswer,
  type RunEvent,
  reject,
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
const presentAsJson = (req: Pick<InterruptRequest, "tool" | "input">) =>
  `── ${req.tool} ──\n${JSON.stringify(req.input, null, 2)}`;

/**
 * Follows a run as a host does (ADR 0009): its events stream from Valkey as a worker writes them.
 * When the run stops for a person (ADR 0029) the questions are shown and asked: a menu for a choice
 * or a yes/no where the terminal draws one, text otherwise, the agent's proposal (or what memory
 * learned) as the default. A write waiting for a yes is the same pause with one `review` question:
 * approve, reject, or send a change back in the same run (ADR 0005). Everything is submitted at
 * once, and the person can also let the agent decide, or go through them again. The decision is
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
    if (last.type !== "question.asked") return last;
    const asked = last.data;
    // a pause replayed from earlier in the run was answered already: carry on past it
    if ((await queue.waitingFor(tenantId, runId)) !== asked.callId) continue;
    const decision = opts.autoApprove
      ? autoDecision(asked.questions, `${opts.by}${AUTO_APPROVED}`)
      : await askQuestions(terminal, asked, opts.by, present);
    if (opts.autoApprove) {
      terminal.line(
        dim(
          asked.subject
            ? `· approved without asking: ${asked.tool}`
            : `· answered with the proposals: ${asked.questions.map((q) => q.id).join(", ")}`,
        ),
      );
    }
    if ((await queue.decide(tenantId, runId, asked.callId, decision)) === undefined) {
      terminal.line(dim("· this was already answered elsewhere"));
    }
  }
}

/** A host that does not ask: each proposal is the answer, and a write is approved. */
function autoDecision(questions: AskedQuestion[], by: string): Decision {
  const answers: Answers = proposedAnswers(questions);
  if (questions.some((q) => q.kind === "review")) answers[REVIEW_ID] = { decision: "approve" };
  return { by, answers };
}

/**
 * The run's questions (ADR 0029), one at a time, then the whole set at once. A person can answer
 * again first, let the agent decide (the proposals are used), or, for a write, reject it.
 */
async function askQuestions(
  terminal: Terminal,
  asked: {
    tool: string;
    questions: AskedQuestion[];
    from: string[];
    subject?: { input: unknown } | undefined;
  },
  by: string,
  present: (req: Pick<InterruptRequest, "tool" | "input">) => string,
): Promise<Decision> {
  const review = asked.questions.find((q) => q.kind === "review");
  const where = asked.from.length > 0 ? ` (from child run ${asked.from.at(-1)?.slice(0, 8)})` : "";
  if (asked.subject) {
    const card = present({ tool: asked.tool, input: asked.subject.input });
    if (terminal.panel) terminal.panel(card);
    else terminal.line(`\n\n${card}`);
  } else {
    const n = asked.questions.length;
    terminal.line(
      `\n${pc.bold(`${asked.tool} has ${n === 1 ? "a question" : `${n} questions`}${where}`)}`,
    );
  }
  for (;;) {
    const answers: Answers = {};
    for (const [i, q] of asked.questions.entries()) {
      if (q.kind === "review") {
        const verdict = await askReview(terminal);
        if (verdict) answers[q.id] = verdict;
        else if (!review) continue;
        continue;
      }
      terminal.line(`\n${pc.bold(`${i + 1}. ${q.question}`)}`);
      terminal.line(dim(`   ${q.why}`));
      const answer = await askOne(terminal, q);
      if (answer !== undefined) answers[q.id] = answer;
    }
    if (review && !answers[review.id]) return rejectedBy(terminal, by);
    // a write waiting for a yes is one decision: nothing to look over before it goes
    if (review && asked.questions.length === 1) return { by, answers };
    terminal.line("");
    for (const q of asked.questions) {
      if (q.kind === "review") continue;
      terminal.line(
        `  ${q.id}: ${q.id in answers ? shownAnswer(answers[q.id] as Answer) : dim("skipped")}`,
      );
    }
    const next = terminal.choose
      ? await terminal.choose(review ? "Send this decision?" : "Submit these answers?", [
          { value: "submit", label: "Submit", hint: "the run carries on with them" },
          { value: "again", label: "Answer again" },
          ...(review
            ? []
            : [
                {
                  value: "decide",
                  label: "Let the agent decide",
                  hint: "it uses its own proposals, and says so",
                },
              ]),
        ])
      : "submit";
    if (next === "submit") return { by, answers };
    if (next === "decide") return { by };
  }
}

/** A write sent back without a decision: reject it, with the person's words. */
async function rejectedBy(terminal: Terminal, by: string): Promise<Decision> {
  const reason = (await terminal.ask("Reason for rejecting")) || "no reason given";
  return reject(by, reason);
}

/** Approve, reject, or send a change back: a menu, or the words a pipe sends. */
async function askReview(terminal: Terminal): Promise<ReviewAnswer | undefined> {
  for (;;) {
    let choice: string;
    if (terminal.choose) {
      choice = await terminal.choose("This step needs a decision", [
        { value: "approve", label: "Approve", hint: "let the agent continue" },
        { value: "reject", label: "Reject", hint: "stop, and say why" },
        { value: "change", label: "Request a change", hint: "send it back in this run" },
      ]);
    } else {
      const text = await terminal.ask(
        `\n${dim("y approve · n reject · or type the change you want")}\n> `,
      );
      if (/^(y|yes)$/i.test(text)) return { decision: "approve" };
      if (/^(n|no)?$/i.test(text)) choice = "reject";
      else return { decision: "change", comment: text.replace(/^change:\s*/i, "") };
    }
    if (choice === "approve") return { decision: "approve" };
    if (choice === "reject") {
      const reason = (await terminal.ask("Reason for rejecting: ")) || "no reason given";
      return { decision: "reject", comment: reason };
    }
    if (choice === "change") {
      const changes = await terminal.ask("What should change?");
      if (changes) return { decision: "change", comment: changes };
      terminal.line("Say what should change, or pick another decision.");
      continue;
    }
    terminal.line("Pick a decision.");
  }
}

const shownAnswer = (a: Answer) =>
  Array.isArray(a)
    ? a.join(", ")
    : typeof a === "boolean"
      ? a
        ? "yes"
        : "no"
      : typeof a === "object"
        ? `${a.decision}${a.comment ? `: ${a.comment}` : ""}`
        : String(a);

const OTHER = "\u0000other";
const SKIP = "\u0000skip";

/**
 * One answer, asked until it fits the question; undefined when the person skips it, which leaves
 * the question to the agent. Enter takes the proposal (what memory learned, when it has).
 */
async function askOne(terminal: Terminal, q: AskedQuestion): Promise<Answer | undefined> {
  const proposed = q.proposed.length > 0 ? proposedValue(q) : undefined;
  if (q.learned) terminal.line(dim(`   ${learnedLine(q)}`));
  for (;;) {
    let value: Answer | undefined;
    if (terminal.choose && (q.kind === "choice" || q.kind === "confirm")) {
      const options =
        q.kind === "confirm"
          ? [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]
          : q.options.map((o) => ({
              value: o.value,
              label: o.label,
              ...(o.description ? { hint: o.description } : {}),
            }));
      // the proposal first, marked, so Enter takes it
      const first = typeof proposed === "boolean" ? (proposed ? "yes" : "no") : proposed;
      const ordered = [
        ...options
          .filter((o) => o.value === first)
          .map((o) => ({ ...o, hint: `proposed${o.hint ? ` · ${o.hint}` : ""}` })),
        ...options.filter((o) => o.value !== first),
        ...(q.allowOther ? [{ value: OTHER, label: "Something else…" }] : []),
        { value: SKIP, label: "Skip", hint: "the agent decides this one" },
      ];
      const picked = await terminal.choose(q.id, ordered);
      if (picked === SKIP) return undefined;
      value =
        picked === OTHER
          ? await terminal.ask("Your answer")
          : q.kind === "confirm"
            ? picked === "yes"
            : picked;
    } else {
      for (const [n, o] of q.options.entries()) {
        terminal.line(`   ${n + 1}) ${o.label}${o.description ? dim(` · ${o.description}`) : ""}`);
      }
      const hint = proposed === undefined ? "" : dim(` [${shownAnswer(proposed)}]`);
      const how =
        q.kind === "multi"
          ? "numbers or values, comma-separated"
          : q.kind === "confirm"
            ? "y or n"
            : q.kind === "choice"
              ? `a number, a value${q.allowOther ? ", or your own words" : ""}`
              : q.kind;
      const typed = await terminal.ask(`   ${dim(`${how}; - to skip`)}${hint}> `);
      if (typed.trim() === "-") return undefined;
      value = typed === "" && proposed !== undefined ? proposed : readTyped(q, typed);
    }
    const problem = invalidAnswer(q, value);
    if (!problem) return value;
    terminal.line(pc.yellow(`   that answer ${problem}`));
  }
}

/** What a person typed, as the answer to `q`: option numbers become their values. */
function readTyped(q: AskedQuestion, typed: string): Answer {
  const pick = (t: string) => {
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 && n <= q.options.length
      ? (q.options[n - 1]?.value ?? t)
      : t;
  };
  if (q.kind === "multi") {
    return typed
      .split(",")
      .map((t) => pick(t.trim()))
      .filter(Boolean);
  }
  if (q.kind === "confirm") {
    return /^(y|yes)$/i.test(typed) ? true : /^(n|no)$/i.test(typed) ? false : typed;
  }
  if (q.kind === "number") return typed.trim() === "" ? Number.NaN : Number(typed);
  if (q.kind === "choice") return pick(typed.trim());
  return typed;
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
  // whose events these are: the run's own, or one of its children's (one stream per invocation)
  let source = "";
  return (e: RunEvent) => {
    const from = e.child?.runId ?? "";
    if (from !== source) {
      source = from;
      note(e.child ? `▸ ${e.child.agentId}` : "▸ back in the run");
    }
    if (e.child && (e.type === "run.completed" || e.type === "run.failed")) {
      note(
        e.type === "run.completed"
          ? `· ${e.child.agentId} ${e.data.status}`
          : `· ${e.child.agentId} failed: ${e.data.message}`,
        e.type === "run.completed" && e.data.status === "completed" ? "dim" : "bad",
      );
      return;
    }
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
      // `{}` is frame.load and the other calls with no arguments. Leave those to tool.started.
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
    else if (e.type === "question.answered")
      note(
        `· ${e.data.source === "memory" ? "answered from memory" : `answered by ${e.data.by}`}: ${Object.entries(
          e.data.answers,
        )
          .map(([k, v]) => `${k} ${shownAnswer(v)}`)
          .join(" · ")}`,
      );
    else if (e.type === "question.asked") {
      finishLive();
      if (midLine) {
        terminal.write("\n");
        midLine = false;
      }
    }
  };
}

/** Where a question's proposal came from (ADR 0033), in a line. */
export function learnedLine(q: AskedQuestion): string {
  const { times, lastAt, from } = q.learned ?? { times: 0, lastAt: "" };
  const last = lastAt.slice(0, 10);
  if (from === "fact") return `the house fact says so (${q.about?.fact ?? "a fact"}, ${last})`;
  const on = q.about?.name
    ? ` on "${q.about.name}"`
    : from === "decision"
      ? " on this section"
      : "";
  return `decided this way${on} ${times} time${times === 1 ? "" : "s"} (last ${last})`;
}
