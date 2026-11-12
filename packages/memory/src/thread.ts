/**
 * What a thread knows (ADR 0031). A thread is a section's life: the Handoff's run, then each run
 * the comments or a data request started. After each invocation a note is kept: what it did, what
 * it made (preview, plan, data, hook), what a person decided, what is still open. The next
 * invocation in the thread starts with the notes, newest first, within a budget: it knows the
 * story without reading the transcripts, and its own window stays its own. Child runs read none:
 * their parent hands them what they need.
 *
 * Three layers, each with its own life: a run's transcript (working memory, ADR 0006), the
 * thread's notes (this), and memory a person approved (facts, lessons, ADR 0013), which
 * consolidation proposes from runs.
 *
 * Notes are made from the run's own record, without a model: the agent's `threadNote` says what it
 * did and, by name, what it made and left open; the events say what a person decided and which
 * children ran. The harness knows no agent's output: without the agent's word, what a run made is
 * read from its output's top-level single-word strings (ids and links), and nothing is open but a
 * failure.
 */

import type { RunEvent } from "@dugout/contracts";
import type { CompletedRun } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import { estimateTokens } from "./context.ts";

export interface ThreadNote {
  runId: string;
  agentId: string;
  status: "completed" | "rejected" | "failed";
  at: string;
  /** What it did, in a sentence or two. */
  did: string;
  /** What it made, by the names its agent gives them. The latest note's win. */
  made: Record<string, string>;
  /** What a person decided when the run asked. */
  decided: string[];
  /** What it left open: issues it reported, why it failed. */
  open: string[];
  /** The child runs it started, and how each ended. */
  children: Array<{ agentId: string; status: string }>;
}

/**
 * One version of the thread's section (migration 026): a preview it had after it was built, made
 * by a run's edits, a person's hand edits, or a person going back to an earlier one.
 */
export interface SectionVersion {
  tree: string;
  fromTree: string | null;
  by: string;
  what: string;
  restored: boolean;
  at: string;
}

/** The versions shown, newest first; the rest are counted. */
const MAX_VERSIONS = 6;

/** What an invocation may add to a thread's context, in tokens. */
export const THREAD_BUDGET_TOKENS = 1_500;
const MAX_OPEN = 8;
const MAX_DECIDED = 6;
const MAX_LINE = 240;
/** The longest value a note keeps as a thing made. */
const MAX_MADE = 600;

/**
 * What an agent says about a run, for its thread's note (`threadNote` in the SDK): a sentence, or
 * the sentence with what the run made (`{ previewUrl: … }`) and left open, by its own names.
 */
export interface ThreadNoteParts {
  did: string;
  made?: Record<string, string>;
  open?: string[];
}

const clip = (s: string, n = MAX_LINE) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What an output names, when its agent did not say: each top-level string that is one word (an id,
 * a link), under its own key. Prose, numbers and lists are not things made.
 */
function madeOf(output: unknown, into: Record<string, string>): void {
  if (!isObject(output)) return;
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === "string" && value && value.length <= MAX_MADE && !/\s/.test(value)) {
      into[key] = value;
    }
  }
}

/** What the agent said made, kept as strings within bounds. */
function declared(made: Record<string, string>, into: Record<string, string>): void {
  for (const [key, value] of Object.entries(made)) {
    if (typeof value === "string" && value && value.length <= MAX_MADE) into[key] = value;
  }
}

/** `{ question → answer }` from what the run asked and what a person (or an auto host) answered. */
function decidedOf(events: readonly RunEvent[]): string[] {
  const asked = new Map<string, Map<string, string>>();
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "question.asked") {
      asked.set(e.data.callId, new Map(e.data.questions.map((q) => [q.id, q.question])));
    } else if (e.type === "question.answered" && e.data.source !== "agent") {
      const questions = asked.get(e.data.callId);
      for (const [id, answer] of Object.entries(e.data.answers ?? {})) {
        const shown =
          typeof answer === "object" && answer !== null && "decision" in answer
            ? `${answer.decision}${answer.comment ? `: ${answer.comment}` : ""}`
            : Array.isArray(answer)
              ? answer.join(", ")
              : String(answer);
        out.push(clip(`${questions?.get(id) ?? id} → ${shown} (${e.data.by})`));
      }
    }
  }
  return out;
}

/** The input's handles, for a note with nothing better to say. */
function inputLine(input: unknown): string {
  if (!isObject(input)) return "";
  const parts = Object.entries(input)
    .filter(([, v]) => typeof v === "string" && (v as string).length <= 200)
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`);
  return parts.join(", ");
}

/**
 * The note an invocation leaves: from its result, its own events and its children's, and the
 * agent's own words when it has a `threadNote`.
 */
export function noteOf(opts: {
  runId: string;
  agentId: string;
  input: unknown;
  result: CompletedRun["result"];
  events: readonly RunEvent[];
  childEvents?: readonly RunEvent[];
  /** The agent's own word on what it did (and made, and left open), from its input and output. */
  said?: string | ThreadNoteParts | undefined;
  at?: string;
}): ThreadNote {
  const { result } = opts;
  const output = result.status === "completed" ? result.output : undefined;
  const made: Record<string, string> = {};
  const children: ThreadNote["children"] = [];
  // children first, so the run's own output wins a name both give
  for (const e of opts.childEvents ?? []) {
    if (!e.child) continue;
    if (e.type === "run.completed") {
      if (e.data.status === "completed") madeOf(e.data.output, made);
      children.push({ agentId: e.child.agentId, status: e.data.status });
    } else if (e.type === "run.failed") {
      children.push({ agentId: e.child.agentId, status: "failed" });
    }
  }
  const said = typeof opts.said === "string" ? { did: opts.said } : opts.said;
  if (said?.made) declared(said.made, made);
  else madeOf(output, made);
  const open = (said?.open ?? []).filter((o) => typeof o === "string" && o.trim());
  if (result.status === "failed") open.unshift(`failed (${result.reason}): ${result.message}`);
  if (result.status === "rejected")
    open.unshift(`a person rejected ${result.output.tool}: ${result.output.reason}`);
  const fallback = `${opts.agentId} ${result.status}${inputLine(opts.input) ? ` on ${inputLine(opts.input)}` : ""}`;
  return {
    runId: opts.runId,
    agentId: opts.agentId,
    status: result.status,
    at: opts.at ?? new Date().toISOString(),
    did: clip(said?.did?.trim() || fallback, 600),
    made,
    decided: decidedOf(opts.events).slice(0, MAX_DECIDED),
    open: open.map((o) => clip(o)).slice(0, MAX_OPEN),
    children,
  };
}

/**
 * The thread as the next invocation reads it: where things stand (what was made, the latest note
 * winning; what the latest note left open), then what happened, newest first. The newest notes are
 * shown whole, older ones a line each, and the oldest dropped once the budget is spent.
 */
export function renderThread(
  notes: readonly ThreadNote[],
  budgetTokens = THREAD_BUDGET_TOKENS,
  versions: readonly SectionVersion[] = [],
): string {
  if (notes.length === 0 && versions.length === 0) return "";
  const ordered = [...notes].sort((a, b) => a.at.localeCompare(b.at));
  const made: Record<string, string> = {};
  for (const n of ordered) Object.assign(made, n.made);
  const latest = ordered[ordered.length - 1];

  const head = [
    "## This thread so far",
    "Earlier runs on this same section. Build on what they made and decided; do not redo it unless asked.",
  ];
  const state: string[] = [];
  const madeLines = Object.entries(made).map(([k, v]) => `- ${k}: ${v}`);
  if (madeLines.length) state.push("What exists now:", ...madeLines);
  // a version newer than any run's note (a person's, by hand or going back) is what exists now
  const newest = [...versions].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (newest && (!latest || newest.at > latest.at)) {
    state.push(
      `Newer than the last run: tree ${newest.tree}, ${newest.by}${newest.restored ? ", went back" : ""}. It is what exists now, not what the last run made.`,
    );
  }
  if (versions.length) {
    const newestFirst = [...versions].sort((a, b) => b.at.localeCompare(a.at));
    state.push(
      "Versions of the section, newest first (the first one is what the preview shows; the section's first, as it was built, is not listed):",
      ...newestFirst
        .slice(0, MAX_VERSIONS)
        .map(
          (v, i) =>
            `- v${versions.length + 1 - i} tree ${v.tree}${v.fromTree ? ` ← ${v.fromTree}` : ""}, ${v.by}${v.restored ? ", went back" : ""}, ${v.at.slice(0, 16).replace("T", " ")}: ${clip(v.what, 160)}`,
        ),
      ...(newestFirst.length > MAX_VERSIONS
        ? [`- …and ${newestFirst.length - MAX_VERSIONS} older`]
        : []),
    );
  }
  if (latest?.open.length) {
    state.push("Left open by the last run:", ...latest.open.map((o) => `- ${o}`));
  }

  const full = (n: ThreadNote) =>
    [
      `- ${n.at.slice(0, 16).replace("T", " ")} ${n.agentId} (${n.status}): ${n.did}`,
      ...(n.children.length
        ? [`  ran: ${n.children.map((c) => `${c.agentId} ${c.status}`).join(", ")}`]
        : []),
      ...n.decided.map((d) => `  decided: ${d}`),
    ].join("\n");
  const short = (n: ThreadNote) =>
    `- ${n.at.slice(0, 10)} ${n.agentId} (${n.status}): ${clip(n.did, 120)}`;

  // where things stand may take half the budget: the rest is for what happened. A line that
  // does not fit is counted, never dropped in silence
  const kept: string[] = [];
  let stateTokens = 0;
  for (const [i, line] of state.entries()) {
    const tokens = estimateTokens(line) + 1;
    if (stateTokens + tokens > budgetTokens / 2) {
      const left = state.length - i;
      kept.push(`- …and ${left} more line${left === 1 ? "" : "s"}`);
      break;
    }
    kept.push(line);
    stateTokens += tokens;
  }
  let text = [...head, ...kept].join("\n");
  let used = estimateTokens(text);
  const history: string[] = [];
  const newestFirst = [...ordered].reverse();
  for (const [i, n] of newestFirst.entries()) {
    const line = i < 3 ? full(n) : short(n);
    const tokens = estimateTokens(line) + 1;
    if (used + tokens > budgetTokens) {
      const left = newestFirst.length - i;
      history.push(`- …and ${left} earlier run${left === 1 ? "" : "s"}`);
      break;
    }
    history.push(line);
    used += tokens;
  }
  if (history.length) text += `\n\nWhat happened, newest first:\n${history.join("\n")}`;
  return text;
}

/** Thread notes in the harness database (migration 020). */
export interface ThreadNotes {
  /** The thread a run is in, if it has one. */
  threadOf(tenantId: string, runId: string): Promise<string | undefined>;
  /** Keeps the note of a run; a run noted twice keeps its latest. */
  add(tenantId: string, threadId: string, note: ThreadNote): Promise<void>;
  /** The thread's notes, oldest first. */
  list(tenantId: string, threadId: string): Promise<ThreadNote[]>;
  /** The versions of the thread's section, oldest first (migration 026). */
  versions?(tenantId: string, threadId: string): Promise<SectionVersion[]>;
}

export function createThreadNotes(pool: Pool): ThreadNotes {
  return {
    threadOf: (tenantId, runId) =>
      withTenant(pool, tenantId, async (db) => {
        const { rows } = await db.query<{ thread_id: string | null }>(
          "select thread_id from runs where id = $1",
          [runId],
        );
        return rows[0]?.thread_id ?? undefined;
      }),
    add: (tenantId, threadId, note) =>
      withTenant(pool, tenantId, async (db) => {
        await db.query(
          `insert into thread_notes (thread_id, tenant_id, run_id, agent_id, note)
           values ($1, $2, $3, $4, $5)
           on conflict (run_id) do update set note = excluded.note, created_at = now()`,
          [threadId, tenantId, note.runId, note.agentId, note],
        );
        await db.query("update threads set updated_at = now() where id = $1", [threadId]);
      }),
    list: (tenantId, threadId) =>
      withTenant(pool, tenantId, async (db) => {
        const { rows } = await db.query<{ note: ThreadNote }>(
          "select note from thread_notes where thread_id = $1 order by created_at",
          [threadId],
        );
        return rows.map((r) => r.note);
      }),
    versions: (tenantId, threadId) =>
      withTenant(pool, tenantId, async (db) => {
        const { rows } = await db.query<{
          tree: string;
          from_tree: string | null;
          by: string;
          what: string;
          restored: boolean;
          created_at: Date;
        }>(
          `select tree, from_tree, by, what, restored_from is not null as restored, created_at
           from section_versions where thread_id = $1 order by created_at`,
          [threadId],
        );
        return rows.map((r) => ({
          tree: r.tree,
          fromTree: r.from_tree,
          by: r.by,
          what: r.what,
          restored: r.restored,
          at: new Date(r.created_at).toISOString(),
        }));
      }),
  };
}
