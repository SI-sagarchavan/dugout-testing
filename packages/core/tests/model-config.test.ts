import { describe, expect, it } from "vitest";
import {
  loadModelConfig,
  modelEntry,
  modelFamily,
  parseModelConfig,
  priceTokens,
  runModel,
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
    for (const name of [
      "nova-micro",
      "nova-lite",
      "nova-2-lite",
      "haiku",
      "sonnet",
      "opus",
      "terra",
    ]) {
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
    expect(modelFamily("global.openai.gpt-6.1-terra")).toBe("openai");
    expect(modelFamily("global.meta.llama-4")).toBeUndefined();
  });

  it("refuses an unknown family, an effort the family doesn't take, strict tools on Nova or a missing price", () => {
    const refuses = (models: Record<string, unknown>, message: string) =>
      expect(() => parseModelConfig({ models })).toThrow(message);
    refuses({ gpt: { ...entry, id: "global.meta.llama-4" } }, "of no known family");
    refuses({ micro: { ...entry, effort: "low" } }, "nova models take no effort");
    refuses(
      { lite2: { ...entry, id: "global.amazon.nova-2-lite-v1:0", effort: "max" } },
      "nova-2 models take low, medium, high",
    );
    refuses({ micro: { ...entry, strictTools: true } }, "nova models don't take strict tools");
    refuses({ micro: { ...entry, forcedTools: true } }, "nova models don't take a forced tool");
    refuses({ micro: { ...entry, price: undefined } }, "price");
    refuses({ micro: { ...entry, temperature: 0 } }, "temperature");
  });
});

describe("an effort in a model name", () => {
  it("is the same model at that effort, and the list keeps its own entry", () => {
    const config = loadModelConfig();
    const base = modelEntry(config, "sonnet");
    const high = modelEntry(config, "sonnet@high");
    expect(high).toEqual({ ...base, effort: "high" });
    expect(modelEntry(config, "sonnet").effort).toBe(base.effort);
  });

  it("is refused for an effort the family doesn't take, or no effort at all", () => {
    const config = loadModelConfig();
    expect(() => modelEntry(config, "nova-2-lite@max")).toThrow(
      "takes the efforts low, medium, high",
    );
    expect(() => modelEntry(config, "nova-micro@low")).toThrow("takes no effort");
    expect(() => modelEntry(config, "sonnet@loud")).toThrow("not an effort");
    expect(() => modelEntry(config, "nope@low")).toThrow("no model named");
  });

  it("is what a run asks for, on the agent's own model unless it names one", () => {
    const config = loadModelConfig();
    expect(runModel(config, "sonnet", {})).toBeUndefined();
    expect(runModel(config, "sonnet", { effort: "high" })).toBe("sonnet@high");
    expect(runModel(config, "sonnet", { model: "haiku" })).toBe("haiku");
    // the picker's "the agent's own" is an empty string, and an effort on it is the agent's model
    expect(runModel(config, "sonnet", { model: "", effort: "high" })).toBe("sonnet@high");
    expect(runModel(config, "sonnet", { model: "" })).toBeUndefined();
    expect(runModel(config, "sonnet", { model: "haiku", effort: "low" })).toBe("haiku@low");
    expect(() => runModel(config, "sonnet", { model: "nova-micro", effort: "low" })).toThrow();
  });
});
