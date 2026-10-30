import { describe, expect, it } from "vitest";
import {
  loadModelConfig,
  modelEntry,
  modelFamily,
  parseModelConfig,
  priceTokens,
} from "../src/index.ts";

const usage = {
  inputTokens: 1_000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 100,
  reasoningTokens: 0,
};
const entry = {
  id: "apac.amazon.nova-micro-v1:0",
  contextWindow: 128_000,
  maxOutputTokens: 10_000,
  price: { input: 0.041, cacheRead: 0.01025, output: 0.164 },
};

describe("the model list", () => {
  it("names every model a spec, judge or lesson writer uses, each with a family and a price", () => {
    const config = loadModelConfig();
    for (const name of ["nova-micro", "nova-lite", "nova-2-lite", "haiku", "sonnet", "opus"]) {
      const model = modelEntry(config, name);
      expect(modelFamily(model.id), name).toBeDefined();
      expect(priceTokens(model.price, usage).costUsd, name).toBeGreaterThan(0);
    }
    expect(priceTokens(modelEntry(config, "nova-micro").price, usage).costUsd).toBeCloseTo(
      (1_000 * 0.041 + 100 * 0.164) / 1_000_000,
    );
  });

  it("holds the same model at two efforts under two names", () => {
    const { models } = loadModelConfig();
    expect(models.sonnet?.id).toBe(models["sonnet-deep"]?.id);
    expect([models.sonnet?.effort, models["sonnet-deep"]?.effort]).toEqual(["medium", "high"]);
  });

  it("reads the family from the Bedrock id", () => {
    expect(modelFamily("global.anthropic.claude-opus-5-5")).toBe("claude");
    expect(modelFamily("in.anthropic.claude-sonnet-5")).toBe("claude");
    expect(modelFamily("global.amazon.nova-2-lite-v1:0")).toBe("nova-2");
    expect(modelFamily("apac.amazon.nova-pro-v1:0")).toBe("nova");
    expect(modelFamily("global.openai.gpt-6")).toBeUndefined();
  });

  it("refuses an unknown family, an effort the family doesn't take, strict tools on Nova or a missing price", () => {
    const refuses = (models: Record<string, unknown>, message: string) =>
      expect(() => parseModelConfig({ models })).toThrow(message);
    refuses({ gpt: { ...entry, id: "global.openai.gpt-6" } }, "of no known family");
    refuses({ micro: { ...entry, effort: "low" } }, "nova models take no effort");
    refuses(
      { lite2: { ...entry, id: "global.amazon.nova-2-lite-v1:0", effort: "max" } },
      "nova-2 models take low, medium, high",
    );
    refuses({ micro: { ...entry, strictTools: true } }, "nova models don't take strict tools");
    refuses({ micro: { ...entry, price: undefined } }, "price");
    refuses({ micro: { ...entry, temperature: 0 } }, "temperature");
  });
});
