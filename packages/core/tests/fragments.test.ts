import type { ModelClient } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import {
  createLocalSteps,
  createMemoryOutputStore,
  createMemorySink,
  createRunLog,
  createToolExecutor,
  createToolRegistry,
  scriptedModelConfig,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider that streams in tiny chunks, as real ones do, with a pause partway. */
const choppy: ModelClient = {
  async complete(_req, onToken, onToolInput) {
    for (const t of ["Sav", "ing", " now"]) onToken?.(t);
    for (const t of ['{"su', 'mmary"', ':"ok"}']) {
      onToolInput?.({ index: 0, callId: "c1", tool: "final", text: t });
    }
    await sleep(40);
    onToolInput?.({ index: 1, callId: "c2", tool: "draft.save", text: "{}" });
    return {
      message: {
        role: "assistant",
        content: "Saving now",
        toolCalls: [
          { id: "c1", name: "final", arguments: '{"summary":"ok"}' },
          { id: "c2", name: "draft.save", arguments: "{}" },
        ],
      },
      tokens: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      servedModel: "choppy",
      finishReason: "tool_calls",
    };
  },
};

describe("streamed fragments", () => {
  it("go out in batches, all before the model call returns", async () => {
    const sink = createMemorySink();
    const log = createRunLog("run-1", [sink]);
    const steps = createLocalSteps({
      ctx: { runId: "run-1", tenantId: "demo-cricket" },
      client: choppy,
      models: scriptedModelConfig(),
      executor: createToolExecutor({
        registry: createToolRegistry([]),
        outputs: createMemoryOutputStore(),
      }),
      approver: async () => ({ approved: true, by: "x" }),
      log,
      fragmentMs: 10,
    });

    await steps.model({ step: 1, model: "nova-lite", messages: [], tools: [] });

    // the first batch after 10 ms, the late fragment flushed when the call returned
    expect(sink.events.map((e) => [e.type, "text" in e.data ? e.data.text : ""])).toEqual([
      ["token", "Saving now"],
      ["tool.input.delta", '{"summary":"ok"}'],
      ["tool.input.delta", "{}"],
    ]);
    expect(sink.events[2]).toMatchObject({ data: { index: 1, callId: "c2", tool: "draft.save" } });
  });
});
