import type { Message } from "@dugout/contracts";
import type { Reading } from "./facts.ts";

/** What a slot or frame ended as (ticket 05): bound, bound to another team's data, or not bound. */
export const DATA_ENDINGS = ["bound", "stand-in", "none"] as const;
export type DataEnding = (typeof DATA_ENDINGS)[number];

/** The `data_source` answer that binds the closest hook for its shape: the data is not the design's. */
export const STAND_IN = "stand_in";

/** What code read of one source's data: whether it is about what the design is about. */
export interface SourceReading {
  /** The name the plan reads it by. */
  as: string;
  hookId: string;
  reading: Reading;
  why?: string;
  /** The plan kept the wrong-team problem with why: the data is the design's after all. */
  kept?: boolean;
}

interface HookMakerAnswer {
  /** Where in the transcript it came. */
  at: number;
  hookId: string | null;
  missing: string[];
  /** How the hook came to be the section's, as hook-maker's code set it (never a model's word). */
  basis?: string;
  must: Array<{ kind: "team" | "competition"; value: string }>;
}

const parse = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

/** Walks the transcript for the result of each call to `tool`, with the arguments it was made with. */
function resultsOf(
  messages: Message[],
  tool: string,
): Array<{ at: number; args: unknown; result: unknown; isError: boolean }> {
  const calls = new Map<string, unknown>();
  const found: Array<{ at: number; args: unknown; result: unknown; isError: boolean }> = [];
  for (const [at, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? [])
        if (call.name === tool) calls.set(call.id, parse(call.arguments));
    } else if (message.role === "tool" && calls.has(message.toolCallId)) {
      found.push({
        at,
        args: calls.get(message.toolCallId),
        result: parse(message.content),
        isError: Boolean(message.isError),
      });
    }
  }
  return found;
}

/** Every answer hook-maker gave in this run, in order, with what the design is about (the call's `need.must`). */
export function hookMakerAnswers(messages: Message[]): HookMakerAnswer[] {
  return resultsOf(messages, "agent.hookMaker").flatMap((r) => {
    if (r.isError) return [];
    const output = (
      r.result as { output?: { hookId?: string | null; missing?: unknown; basis?: unknown } }
    )?.output;
    if (!output || typeof output !== "object") return [];
    const must = (r.args as { need?: { must?: { team?: string; competition?: string } } })?.need
      ?.must;
    return [
      {
        at: r.at,
        hookId: typeof output.hookId === "string" ? output.hookId : null,
        missing: Array.isArray(output.missing) ? output.missing.map(String) : [],
        ...(typeof output.basis === "string" ? { basis: output.basis } : {}),
        must: [
          ...(must?.team ? [{ kind: "team" as const, value: must.team }] : []),
          ...(must?.competition ? [{ kind: "competition" as const, value: must.competition }] : []),
        ],
      },
    ];
  });
}

/** The last answer hook-maker gave in this run. */
export function lastHookMaker(messages: Message[]): HookMakerAnswer | undefined {
  return hookMakerAnswers(messages).at(-1);
}

/**
 * The providers and connectors hook-maker created in this run, as it reported them: what a run
 * leaves in a space other runs and people share, so the host can show it.
 */
export function createdIn(messages: Message[]): string[] {
  const found = new Set<string>();
  for (const { result, isError } of resultsOf(messages, "agent.hookMaker")) {
    if (isError) continue;
    const created = (result as { output?: { created?: unknown } })?.output?.created;
    if (Array.isArray(created)) for (const line of created) found.add(String(line));
  }
  return [...found];
}

/**
 * How `data_source` was settled, whoever settled it: a person's answer to `ask` in this run, or
 * what a person decided on this section before (bind.load's `settled`, read from memory). The
 * latest wins; `at` is where in the transcript it was settled.
 */
export function dataSourceSettled(messages: Message[]): { value: string; at: number } | undefined {
  const settled: Array<{ value: string; at: number }> = [];
  for (const { at, result } of resultsOf(messages, "ask")) {
    const answers = (result as { answers?: Array<{ id?: string; answer?: unknown }> })?.answers;
    const mine = answers?.find((a) => a.id === "data_source");
    if (mine && typeof mine.answer === "string") settled.push({ value: mine.answer, at });
  }
  for (const { at, result, isError } of resultsOf(messages, "bind.load")) {
    const value = (result as { settled?: { data_source?: unknown } })?.settled?.data_source;
    if (!isError && typeof value === "string") settled.push({ value, at });
  }
  return settled.sort((a, b) => a.at - b.at).at(-1);
}

/** What a person answered to `data_source`, in this run or before it: the option's value, or what they typed. */
export function dataSourceAnswer(messages: Message[]): string | undefined {
  return dataSourceSettled(messages)?.value;
}

/** The latest source of each name, as bind.source read it in this run. */
export function sourcesIn(messages: Message[]): SourceReading[] {
  const latest = new Map<string, SourceReading>();
  for (const { result, isError } of resultsOf(messages, "bind.source")) {
    const r = result as {
      as?: unknown;
      hookId?: unknown;
      about?: { reading?: unknown; why?: unknown };
    };
    if (isError || typeof r?.as !== "string" || typeof r.hookId !== "string") continue;
    const reading = r.about?.reading;
    latest.set(r.as, {
      as: r.as,
      hookId: r.hookId,
      reading: reading === "about" || reading === "other" ? reading : "unknown",
      ...(typeof r.about?.why === "string" ? { why: r.about.why } : {}),
    });
  }
  return [...latest.values()];
}

/** A person's own data: a hook built on the feeds they gave, or one they chose. */
const PEOPLES = new Set(["sources", "chosen"]);

/**
 * Whether the data bound is about something else than the design (ticket 05, 09): `stand-in`,
 * with why, set by code and never by the model. Read from the latest source of each name (as
 * bind.publish recorded them, else as bind.source read them):
 *
 * - its data names other teams and none the design is about, and the plan did not keep that with
 *   why; or
 * - a person settled `data_source` as `stand_in` (in this run, or before it), and the source is
 *   still the closest hook they settled for: not one their own feeds built or they chose, not one
 *   whose data names what the design is about, and not a hook hook-maker gave after they answered.
 */
export function standInIn(
  messages: Message[],
  published?: { standIn?: string; readings?: SourceReading[] },
): string | undefined {
  if (published?.standIn) return published.standIn;
  const readings = published?.readings?.length ? published.readings : sourcesIn(messages);
  const other = readings.find((r) => r.reading === "other" && !r.kept);
  if (other) return other.why ?? `the data of ${other.hookId} is about another team`;
  const settled = dataSourceSettled(messages);
  if (settled?.value !== STAND_IN) return undefined;
  const answers = hookMakerAnswers(messages);
  // the hook the person settled for: hook-maker's last answer before they answered
  const closest = answers.filter((a) => a.at < settled.at).at(-1)?.hookId ?? undefined;
  for (const r of readings) {
    if (r.reading === "about") continue;
    const gave = answers.filter((a) => a.hookId === r.hookId).at(-1);
    if (gave?.basis && PEOPLES.has(gave.basis)) continue;
    if (closest && r.hookId !== closest) continue;
    const about = (gave ?? answers.at(-1))?.must.map((m) => m.value).join(", ");
    return `a person chose the closest hook, ${r.hookId}, for want of data about ${about || "the design"}`;
  }
  return undefined;
}
