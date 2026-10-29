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
 * DeepSeek list prices (api-docs.deepseek.com/quick_start/pricing, checked 2026-10-29). Peak is
 * 01:00–04:00 and 06:00–10:00 UTC on weekdays; off-peak is half price. Chinese public holidays are
 * also off-peak but not modelled, so reported cost can run high on those days.
 */
export const DEEPSEEK_PRICING: Pricing = {
  prices: {
    "deepseek-flash": { inputCacheHit: 0.006, inputCacheMiss: 0.3, output: 1.2 },
    "deepseek-v4-pro": { inputCacheHit: 0.044, inputCacheMiss: 1.32, output: 3.96 },
  },
  rateAt(at) {
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    const weekday = day >= 1 && day <= 5;
    const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    return peak ? 1 : 0.5;
  },
};
