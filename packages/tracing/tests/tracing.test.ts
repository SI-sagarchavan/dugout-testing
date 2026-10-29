import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defineTool } from "@dugout/contracts";
import {
  createMemoryOutputStore,
  createScriptedModel,
  runLocal,
  scriptedModelConfig,
} from "@dugout/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTracerProvider, createTracingSink, langfuseExporter } from "../src/index.ts";

const save = defineTool({
  name: "draft.save",
  description: "save",
  input: z.object({ text: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  run: async () => ({ saved: true }),
});

describe("tracing sink", () => {
  it("records one trace per run with model, tool and approval spans under the run", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider(new SimpleSpanProcessor({ exporter }));
    const result = await runLocal({
      agent: {
        spec: {
          id: "traced",
          version: 1,
          owner: "t",
          instructions: "x",
          tools: ["draft.save"],
          skills: [],
          model: { tier: "fast" },
          memory: { read: [], write: [] },
          budget: { usdPerRun: 1, maxSteps: 4, maxDepth: 0 },
          approvals: [],
        },
      },
      input: "go",
      tenantId: "demo-cricket",
      tools: [save],
      client: createScriptedModel([
        { toolCalls: [{ name: "draft.save", arguments: { text: "hi" } }] },
        { content: "done" },
      ]),
      models: scriptedModelConfig(),
      approver: async () => ({ approved: true, by: "editor" }),
      runsDir: await mkdtemp(`${tmpdir()}/trace-`),
      outputs: createMemoryOutputStore(),
      sinks: [createTracingSink(provider.getTracer("test"))],
    });
    expect(result.status).toBe("completed");

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "run traced");
    expect(root?.attributes).toMatchObject({
      "dugout.tenant_id": "demo-cricket",
      "dugout.status": "completed",
    });
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(spans.map((s) => s.name).sort()).toEqual(
      [
        "approval draft.save",
        "model step 1",
        "model step 2",
        "run traced",
        "tool draft.save",
      ].sort(),
    );
    for (const s of spans.filter((s) => s !== root)) {
      expect(s.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    const step = spans.find((s) => s.name === "model step 1");
    expect(step?.attributes).toMatchObject({
      "langfuse.observation.type": "generation",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.response.model": "scripted-fast",
    });
    expect(spans.find((s) => s.name === "approval draft.save")?.attributes).toMatchObject({
      "dugout.approver": "editor",
    });
  });

  it("is off unless both Langfuse keys are set", () => {
    expect(langfuseExporter({})).toBeUndefined();
    expect(langfuseExporter({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeUndefined();
    expect(
      langfuseExporter({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }),
    ).toBeDefined();
  });
});
