import type { TokenUsage } from "@dugout/contracts";

/** USD per 1M tokens at the list (peak) rate. */
export interface ModelPrice {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

export interface Pricing {
  prices: Record<string, ModelPrice>;
  /** Multiplier on the list rate at a given time; 1 at peak. */
  rateAt(at: Date): number;
}

/**
 * Budgets are enforced at the list rate so a run's limit doesn't depend on the clock; the reported
 * cost uses the rate at the time of the call.
 */
export function priceTokens(pricing: Pricing, model: string, tokens: TokenUsage, at: Date) {
  const price = pricing.prices[model];
  if (!price) throw new Error(`no price configured for model ${model}`);
  const misses = tokens.inputTokens - tokens.cachedInputTokens;
  const budgetCostUsd =
    (tokens.cachedInputTokens * price.inputCacheHit +
      misses * price.inputCacheMiss +
      tokens.outputTokens * price.output) /
    1_000_000;
  return { budgetCostUsd, costUsd: budgetCostUsd * pricing.rateAt(at) };
}

/**
 * Amazon Bedrock on-demand list prices in ap-south-1 (Mumbai), from the AWS Price List API
 * (pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-south-1/index.json,
 * published 2026-10-29, checked 2026-10-30). Cross-region inference profiles (`apac.*`) are billed
 * at the price of the region the request is sent from. Bedrock has no off-peak rate.
 */
export const BEDROCK_PRICING: Pricing = {
  prices: {
    "apac.amazon.nova-micro-v1:0": { inputCacheHit: 0.01025, inputCacheMiss: 0.041, output: 0.164 },
    "apac.amazon.nova-lite-v1:0": { inputCacheHit: 0.01775, inputCacheMiss: 0.071, output: 0.284 },
    "apac.amazon.nova-pro-v1:0": { inputCacheHit: 0.235, inputCacheMiss: 0.94, output: 3.76 },
  },
  rateAt: () => 1,
};
