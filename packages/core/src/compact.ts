import type { Message, RunCheckpoint, ToolDefinition } from "@dugout/contracts";

/**
 * Keeping a long run inside its model's window (ticket thread-context/02).
 *
 * The saved transcript only grows (`RunStore`), so nothing here rewrites it. What was compacted is
 * a small record in the checkpoint (`RunCheckpoint.compacted`), and the messages the model reads
 * are the transcript with that record applied. A resumed run, or a fork of an earlier save point,
 * reads the same view it would have read.
 */
export type Compacted = NonNullable<RunCheckpoint["compacted"]>;

export interface CompactionOptions {
  /** The model's context window, in tokens. */
  window: number;
  /** Compact when the request passes this share of the window. */
  at?: number;
  /** The latest assistant turns (with their results) that are always kept as they are. */
  keep?: number;
  /** Stores a tool result that leaves the transcript and returns its reference. */
  store(content: string): Promise<string>;
  /**
   * Writes the "state so far" from the older turns (a cheaper model than the run's); nothing when
   * it could not, and the run goes on with what the references saved.
   */
  summarize(prompt: string): Promise<string | undefined>;
}

export const COMPACT_AT = 0.65;
export const COMPACT_KEEP = 3;
/** A tool result shorter than this stays as it is: its reference would be hardly smaller. */
const ELIDE_OVER = 2_000;
const PREVIEW = 300;
/** Characters to a token, low on purpose: JSON and ids cost more than prose. */
const CHARS_PER_TOKEN = 3.5;

const charsOf = (m: Message): number =>
  m.content.length +
  (m.role === "assistant"
    ? (m.toolCalls ?? []).reduce((n, c) => n + c.name.length + c.arguments.length, 0)
    : 0);

/** What a request costs in tokens, roughly: its messages and its tool definitions. */
export function estimateTokens(messages: Message[], tools: ToolDefinition[] = []): number {
  const chars = messages.reduce((n, m) => n + charsOf(m), 0) + JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The messages the model reads: the transcript with what was compacted applied. */
export function compactedView(messages: Message[], c: Compacted | undefined): Message[] {
  if (!c) return messages;
  const out: Message[] = [];
  for (const [i, m] of messages.entries()) {
    if (c.summary && i >= 2 && i < c.upTo) {
      if (i === 2) {
        out.push({
          role: "user",
          content: `## State so far\nEarlier turns of this run were replaced by this summary.\n\n${c.summary}`,
        });
      }
      continue;
    }
    const stub = m.role === "tool" ? c.elided[m.toolCallId] : undefined;
    out.push(stub === undefined || m.role !== "tool" ? m : { ...m, content: stub });
  }
  return out;
}

export interface Compaction {
  tokensBefore: number;
  tokensAfter: number;
  /** Tool results replaced by a reference. */
  elided: number;
  /** Transcript messages replaced by the summary. */
  summarized: number;
}

/**
 * Makes the view smaller when it passes the share of the window, and records how in `state`.
 * First the older tool results become references (no model needed); only if that is not enough
 * are the older turns summarised. The system prompt, the first user message and the latest turns
 * are untouched, and a tool call is never parted from its results: the cut falls before an
 * assistant message, after all the results of the turn before it.
 */
export async function compact(
  messages: Message[],
  state: RunCheckpoint,
  tools: ToolDefinition[],
  opts: CompactionOptions,
): Promise<Compaction | undefined> {
  const limit = Math.floor(opts.window * (opts.at ?? COMPACT_AT));
  const tokensBefore = estimateTokens(compactedView(messages, state.compacted), tools);
  if (tokensBefore <= limit) return undefined;

  const assistants = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  // the first message the model reads as it was written; before it is fair game
  const cutFor = (keep: number) => assistants[assistants.length - keep];
  const next: Compacted = state.compacted
    ? { ...state.compacted, elided: { ...state.compacted.elided } }
    : { upTo: 0, elided: {} };
  let cut = cutFor(opts.keep ?? COMPACT_KEEP);
  if (cut === undefined) cut = cutFor(1);
  if (cut === undefined) return undefined;

  let elided = 0;
  for (const [i, m] of messages.entries()) {
    if (i >= cut || m.role !== "tool" || m.toolCallId in next.elided) continue;
    if (m.content.length <= ELIDE_OVER) continue;
    const ref = await opts.store(m.content);
    next.elided[m.toolCallId] = JSON.stringify({
      ref,
      chars: m.content.length,
      preview: m.content.slice(0, PREVIEW),
      note: "Compacted to save room. Call run.readOutput with this ref to read it again.",
    });
    elided++;
  }
  let summarized = 0;
  if (estimateTokens(compactedView(messages, next), tools) > limit) {
    const from = next.summary ? next.upTo : 2;
    if (cut > from) {
      const older = compactedView(messages, { ...next, summary: undefined, upTo: 0 }).slice(
        from,
        cut,
      );
      const summary = await opts.summarize(summaryPrompt(next.summary, older));
      if (summary) {
        next.summary = summary;
        summarized = cut - from;
        next.upTo = cut;
      }
    }
  }
  if (elided === 0 && summarized === 0) return undefined;
  state.compacted = next;
  return {
    tokensBefore,
    tokensAfter: estimateTokens(compactedView(messages, next), tools),
    elided,
    summarized,
  };
}

export const SUMMARY_SYSTEM =
  "You write the memory of an agent that is part-way through a task. You get what it knew so far and its next stretch of work, and write what it must know to carry on without them. Be exact and short.";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length} chars]` : s);

/** The older turns as text for the summariser. */
export function summaryPrompt(previous: string | undefined, older: Message[]): string {
  const lines = older.map((m) => {
    if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c) => `  call ${c.name} ${clip(c.arguments, 1_500)}`);
      return [`assistant: ${clip(m.content, 2_000)}`, ...calls].join("\n");
    }
    if (m.role === "tool") return `result${m.isError ? " (error)" : ""}: ${clip(m.content, 1_500)}`;
    return `${m.role}: ${clip(m.content, 2_000)}`;
  });
  return [
    previous ? `What it knew so far:\n${previous}\n` : "",
    `Its next stretch of work:\n${lines.join("\n")}`,
    "",
    "Write the state so far, under these headings, leaving none out and adding nothing else:",
    "## Tried — what it did, and what each thing returned",
    "## Found — facts it learned (keep every id, name, number, URL and output ref exactly)",
    "## Decided — choices made, and why",
    "## Next — what is left to do",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
