import { defineTool } from "@dugout/contracts";
import { z } from "zod";
import type { MemoryReader } from "./store.ts";

export const SEARCH_TOOL = "memory.search";
export const PROPOSE_TOOL = "memory.propose";

/** Read-only memory tools for one agent. The tenant comes from the tool context. */
export function createMemoryTools(opts: { reader: MemoryReader; agentId: string }) {
  const search = defineTool({
    name: SEARCH_TOOL,
    description:
      "Search this tenant's reviewed facts and past feedback. Use it when you need a house rule or lesson that isn't already in your instructions.",
    input: z.object({
      query: z.string().min(2),
      kinds: z
        .array(z.enum(["semantic", "episodic"]))
        .min(1)
        .default(["semantic", "episodic"]),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    effect: "read",
    timeoutMs: 10_000,
    async run({ query, kinds, limit }, ctx) {
      const items = await opts.reader.search({
        tenantId: ctx.tenantId,
        agentId: opts.agentId,
        query,
        kinds,
        limit,
      });
      return items.map(({ kind, key, content, createdAt }) => ({ kind, key, content, createdAt }));
    },
  });

  // Records a proposal in the run's events only; consolidation stores it and a reviewer decides.
  const propose = defineTool({
    name: PROPOSE_TOOL,
    description:
      "Propose a new or corrected house fact for this tenant. A human reviews it before any run uses it.",
    input: z.object({
      key: z.string().regex(/^[a-z][a-z0-9.-]*$/, "dotted lower-case key, e.g. style.spelling"),
      content: z.string().min(5).max(500),
      confidence: z.number().min(0).max(1),
    }),
    effect: "read",
    timeoutMs: 1_000,
    run: async () => ({ recorded: true, note: "A reviewer must approve this before it is used." }),
  });

  return [search, propose];
}
