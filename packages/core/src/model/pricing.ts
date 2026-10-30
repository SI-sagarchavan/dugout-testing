import type { TokenUsage } from "@dugout/contracts";
import { z } from "zod";

/** USD per 1M tokens. A cache write with no price of its own costs what input does. */
export const ModelPrice = z
  .object({
    input: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative().optional(),
    output: z.number().nonnegative(),
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * What a call cost. Bedrock charges the same at every hour, so the cost reported and the cost
 * budgets are held to are the same.
 */
export function priceTokens(price: ModelPrice, tokens: TokenUsage) {
  const uncached = tokens.inputTokens - tokens.cachedInputTokens - tokens.cacheWriteInputTokens;
  const costUsd =
    (uncached * price.input +
      tokens.cachedInputTokens * price.cacheRead +
      tokens.cacheWriteInputTokens * (price.cacheWrite ?? price.input) +
      tokens.outputTokens * price.output) /
    1_000_000;
  return { costUsd, budgetCostUsd: costUsd };
}
