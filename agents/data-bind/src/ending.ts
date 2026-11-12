import { answeredCalls, type Message } from "@dugout/contracts";

/**
 * What a slot or frame ended as (ticket 05): bound, bound to data about something else (a
 * stand-in), or not bound. The model says which in its final, with why; code says none only when
 * nothing was bound.
 */
export const DATA_ENDINGS = ["bound", "stand-in", "none"] as const;
export type DataEnding = (typeof DATA_ENDINGS)[number];

/** The `data_source` answer that binds the closest hook for its shape: the data is not the design's. */
export const STAND_IN = "stand_in";

const parse = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

/**
 * The providers and connectors hook-maker created in this run, as it reported them: what a run
 * leaves in a space other runs and people share, so the host can show it.
 */
export function createdIn(messages: Message[]): string[] {
  const found = new Set<string>();
  for (const call of answeredCalls(messages, "agent.hookMaker")) {
    if (call.isError) continue;
    const created = (parse(call.content) as { output?: { created?: unknown } })?.output?.created;
    if (Array.isArray(created)) for (const line of created) found.add(String(line));
  }
  return [...found];
}
