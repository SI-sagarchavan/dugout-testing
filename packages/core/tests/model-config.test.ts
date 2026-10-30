import { describe, expect, it } from "vitest";
import { loadModelConfig, priceTokens } from "../src/index.ts";

const usage = { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0 };

describe("loadModelConfig", () => {
  it("defaults to Nova Micro and Nova Lite through their APAC inference profiles", () => {
    expect(loadModelConfig({}).tiers).toEqual({
      fast: { model: "apac.amazon.nova-micro-v1:0", contextWindow: 128_000 },
      smart: { model: "apac.amazon.nova-lite-v1:0", contextWindow: 300_000 },
    });
  });

  it("prices every default, at a flat rate", () => {
    const config = loadModelConfig({});
    const at = new Date("2026-10-30T07:00:00Z");
    for (const tier of Object.values(config.tiers)) {
      const cost = priceTokens(config.pricing, tier.model, usage, at);
      expect(cost.costUsd).toBeGreaterThan(0);
      expect(cost.costUsd).toBe(cost.budgetCostUsd);
    }
    expect(
      priceTokens(config.pricing, "apac.amazon.nova-micro-v1:0", usage, at).costUsd,
    ).toBeCloseTo((1_000 * 0.041 + 100 * 0.164) / 1_000_000);
  });

  it("takes model overrides", () => {
    const config = loadModelConfig({ LLM_MODEL_SMART: "apac.amazon.nova-pro-v1:0" });
    expect(config.tiers.smart.model).toBe("apac.amazon.nova-pro-v1:0");
    expect(config.tiers.fast.model).toBe("apac.amazon.nova-micro-v1:0");
  });
});
