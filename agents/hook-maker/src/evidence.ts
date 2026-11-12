import { defineTool } from "@dugout/contracts";
import { observed } from "@dugout/mcp";
import { z } from "zod";
import { type About, namesIn } from "./entity.ts";
import {
  countEvidence,
  fieldEvidence,
  filterEvidence,
  type NeedItem,
  type Order,
  orderEvidence,
} from "./fit.ts";

/** The parts of the need the evidence is read against. */
interface NeedShape {
  count?: number | "data";
  item?: NeedItem[];
  order?: Order;
  must?: About;
  filterBy?: { key: string; options: string[] };
  paged?: boolean;
}

/**
 * Where a paged list stands, as the output says it: what its top holds at `next`, beside the rule
 * the page reads it by. Undefined when the need is not paged.
 */
export function pagingEvidence(paged: boolean | undefined, output: unknown) {
  if (!paged) return undefined;
  const top =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : {};
  return {
    next: "next" in top ? top.next : "(none: the output has no next)",
    rule: "The need is paged: the page asks for the next page by running the hook again with another page input, adds its items to the list, and reads next (the next page's number, null on the last) to hide its LOAD MORE. A run at page 2 shows the next items and next moving on.",
  };
}

/**
 * What a hook's output shows against the need, from the output its last run with the transform
 * applied in this run gave (observed by the Cast adapter): the values at each covers path beside
 * the design's example, the lists and their lengths beside the count, the dates in output order
 * beside the need's order and the time now, how many items each option of the page's choice has,
 * and what the data names beside the need's `must`. It judges nothing: the model does.
 */
export function evidenceFor(
  need: NeedShape,
  covers: string[],
  output: unknown,
  now: number = Date.now(),
) {
  const order = orderEvidence(need.order, covers, output, now);
  const filter = filterEvidence(need.filterBy, covers, output);
  const names = namesIn(output, need.must);
  const paging = pagingEvidence(need.paged, output);
  const items = need.item ?? [];
  const fields = fieldEvidence(items, covers, output);
  const named = new Set(fields.map((f) => f.field));
  const unnamed = items.filter((i) => !named.has(i.field)).map((i) => i.field);
  return {
    fields,
    ...(unnamed.length ? { notInCovers: unnamed } : {}),
    count: countEvidence(need.count, covers, output),
    ...(order ? { order } : {}),
    ...(filter ? { filterBy: filter } : {}),
    ...(names ? { names } : {}),
    ...(paging ? { paging } : {}),
  };
}

export const EVIDENCE_RULE =
  "Evidence, not a verdict: judge from it whether the values are in the design's form (its example), the items are in the need's order and enough for its count, and the data is about the need's must. Fix the hook when they are not and the feed allows it; otherwise say so in missing (and about), with what the evidence shows.";

export const evidenceTool = defineTool({
  name: "hook.evidence",
  description:
    "What a hook's output really holds against the need, from its last run with the transform applied in this run: for each covers line, a few of the values at its path beside the design's example and kind, and how many items have one; the need's fields no covers line names; the lists your paths go through and how many items each holds, beside need.count; with need.order and an `order → <path>` line, the dates in output order with how they run and how many are before and after now; with filterBy, how many items hold each option; with must, how often its words appear in the data and the short texts the data holds most, with where; with paged, what the output answers at next. It judges nothing: you do. Call it after the hook's last run, with the covers you mean to answer, before final.",
  input: z
    .object({
      hookId: z.string().min(1),
      covers: z
        .array(z.string())
        .describe("The covers you mean to answer with: `<the need's field> → <path>`"),
    })
    .strict(),
  effect: "read",
  timeoutMs: 10_000,
  async run({ hookId, covers }, ctx) {
    const output = observed(ctx.runId, `hookRun:${hookId}`);
    if (output === undefined) {
      return {
        hookId,
        note: `No run of ${hookId} with its transform applied was seen in this run: run it with cast.runHook (applyTransform true), then call this again.`,
      };
    }
    const need = ((ctx.input as { need?: NeedShape } | undefined)?.need ?? {}) as NeedShape;
    return { hookId, ...evidenceFor(need, covers, output), rule: EVIDENCE_RULE };
  },
});
