import type { ModelTier } from "@dugout/contracts";
import { DEEPSEEK_PRICING, type Pricing } from "./pricing.ts";

export interface TierConfig {
  model: string;
  contextWindow: number;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
}

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  /** Send assistant reasoning back on later turns (DeepSeek requires it with tools). */
  replayReasoning: boolean;
  tiers: Record<ModelTier, TierConfig>;
  pricing: Pricing;
}

const THINKING = { thinking: { type: "enabled" } };

/**
 * DeepSeek defaults (ADR 0001): both tiers use `deepseek-flash` with thinking, differing only in
 * effort. Base URL and model ids can be overridden from the environment.
 */
export function loadModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is not set; see .env.example");
  return {
    baseURL: env.LLM_BASE_URL || "https://api.deepseek.com",
    apiKey,
    replayReasoning: true,
    tiers: {
      fast: {
        model: env.LLM_MODEL_FAST || "deepseek-flash",
        contextWindow: 1_000_000,
        reasoningEffort: "low",
        extraBody: THINKING,
      },
      smart: {
        model: env.LLM_MODEL_SMART || "deepseek-flash",
        contextWindow: 1_000_000,
        reasoningEffort: "high",
        extraBody: THINKING,
      },
    },
    pricing: DEEPSEEK_PRICING,
  };
}
