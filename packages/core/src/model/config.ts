import type { ModelTier } from "@dugout/contracts";
import { BEDROCK_PRICING, type Pricing } from "./pricing.ts";

export interface TierConfig {
  model: string;
  contextWindow: number;
}

export interface ModelConfig {
  tiers: Record<ModelTier, TierConfig>;
  pricing: Pricing;
}

/**
 * Amazon Bedrock (ADR 0012): Nova Micro and Nova Lite through their APAC inference profiles, since
 * ap-south-1 accepts only inference profile ids, not bare ids like `amazon.nova-micro-v1:0`. Callers
 * override the ids with LLM_MODEL_FAST and LLM_MODEL_SMART. An override needs a price in
 * `BEDROCK_PRICING`, and keeps the default's context window.
 */
export function loadModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig {
  return {
    tiers: {
      fast: { model: env.LLM_MODEL_FAST || "apac.amazon.nova-micro-v1:0", contextWindow: 128_000 },
      smart: { model: env.LLM_MODEL_SMART || "apac.amazon.nova-lite-v1:0", contextWindow: 300_000 },
    },
    pricing: BEDROCK_PRICING,
  };
}
