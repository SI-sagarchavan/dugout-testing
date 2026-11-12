import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { approve, defineTool } from "@dugout/contracts";
import {
  createMemoryOutputStore,
  createMemoryRunStore,
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
  it("records one trace per run with model, tool and review spans under the run", async () => {
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
          onDemandSkills: [],
          model: "nova-micro",
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
      responder: async () => approve("editor"),
      runsDir: await mkdtemp(`${tmpdir()}/trace-`),
      outputs: createMemoryOutputStore(),
      sinks: [createTracingSink(provider.getTracer("test"))],
    });
    expect(result.status).toBe("completed");

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "traced");
    expect(root?.attributes).toMatchObject({
      "langfuse.trace.name": "traced",
      "langfuse.observation.type": "agent",
      "langfuse.user.id": "demo-cricket",
      "langfuse.environment": "development",
      "langfuse.trace.tags": ["agent:traced", "tenant:demo-cricket"],
      "langfuse.trace.metadata.tenant_id": "demo-cricket",
      "langfuse.observation.metadata.status": "completed",
    });
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    // stable names: no step numbers or ids, so evaluators and dashboards keep matching
    expect(spans.map((s) => s.name).sort()).toEqual(
      ["await-approval", "call-model", "call-model", "traced", "draft.save"].sort(),
    );
    for (const s of spans.filter((s) => s !== root)) {
      expect(s.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    const [first, second] = spans.filter((s) => s.name === "call-model");
    expect(first?.attributes).toMatchObject({
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": "nova-micro",
      "langfuse.observation.metadata.step": "1",
    });
    // exclusive token buckets, and the answer as an assistant message whose calls render as cards
    expect(
      JSON.parse(String(first?.attributes["langfuse.observation.usage_details"])),
    ).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
    expect(JSON.parse(String(first?.attributes["langfuse.observation.output"]))).toMatchObject({
      role: "assistant",
      tool_calls: [{ type: "function", function: { name: "draft.save" } }],
    });
    // the second call's input is what the model newly saw: the tool's result
    expect(JSON.parse(String(second?.attributes["langfuse.observation.input"]))).toMatchObject([
      { role: "tool" },
    ]);
    const approval = spans.find((s) => s.name === "await-approval");
    expect(approval?.attributes).toMatchObject({
      "langfuse.observation.type": "guardrail",
      "langfuse.observation.metadata.by": "editor",
    });
    expect(String(approval?.attributes["langfuse.observation.output"])).toContain("approve");
  });

  it("nests a child agent under its parent's call, in the parent's trace", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider(new SimpleSpanProcessor({ exporter }));
    const calls = new Map();
    const sessions = async (_t: string, runId: string) => (runId === "p" ? "thread-1" : undefined);
    const parent = createTracingSink(provider.getTracer("t"), { calls, sessionOf: sessions });
    const child = createTracingSink(provider.getTracer("t"), { calls, sessionOf: sessions });
    const at = (n: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, n)).toISOString();
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 0,
      costUsd: 0.01,
      budgetCostUsd: 0.01,
      steps: 1,
    };
    const e = (runId: string, n: number, type: string, data: unknown) =>
      ({ runId, seq: n, at: at(n), type, data }) as never;
    await parent.write(
      e("p", 1, "run.started", {
        agentId: "data-bind",
        agentVersion: 1,
        tenantId: "sb",
        input: {},
      }),
    );
    await parent.write(
      e("p", 2, "tool.started", {
        step: 1,
        tool: "agent.hookMaker",
        input: { need: {} },
        callId: "c1",
      }),
    );
    await child.write(
      e("k", 3, "run.started", {
        agentId: "hook-maker",
        agentVersion: 3,
        tenantId: "sb",
        input: { need: {} },
        parent: { runId: "p", callId: "c1" },
      }),
    );
    await child.write(
      e("k", 4, "step.completed", {
        step: 1,
        usage,
        message: { role: "assistant", content: "found it", toolCalls: [] },
        servedModel: "global.anthropic.claude-sonnet-5-5",
        finishReason: "end_turn",
      }),
    );
    await child.write(
      e("k", 5, "run.completed", { status: "completed", output: { hookId: "h" }, usage }),
    );
    await parent.write(
      e("p", 6, "tool.completed", {
        ok: true,
        step: 1,
        tool: "agent.hookMaker",
        callId: "c1",
        content: "{}",
        durationMs: 1,
      }),
    );
    await parent.write(e("p", 7, "run.completed", { status: "completed", output: {}, usage }));

    const spans = exporter.getFinishedSpans();
    // one trace: the child is an agent observation in its parent's, not a trace of its own
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const root = spans.find((s) => s.name === "data-bind");
    const agent = spans.find((s) => s.name === "hook-maker");
    expect(root?.attributes["langfuse.session.id"]).toBe("thread-1");
    expect(agent?.attributes["langfuse.observation.type"]).toBe("agent");
    expect(agent?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    const call = spans.find((s) => s.name === "call-model");
    expect(call?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId);
    expect(JSON.parse(String(call?.attributes["langfuse.observation.usage_details"]))).toEqual({
      input: 30,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
      output: 20,
    });
  });

  it("gives a run resumed in a new process its own trace, in the same session", async () => {
    const store = createMemoryRunStore();
    const runsDir = await mkdtemp(`${tmpdir()}/trace-`);
    const spec = {
      id: "traced",
      version: 1,
      owner: "t",
      instructions: "x",
      tools: ["draft.save"],
      skills: [],
      onDemandSkills: [],
      model: "nova-micro",
      memory: { read: [], write: [] },
      budget: { usdPerRun: 1, maxSteps: 4, maxDepth: 0 },
      approvals: [],
    };
    const invoke = async (
      exporter: InMemorySpanExporter,
      script: Parameters<typeof createScriptedModel>[0],
      resume?: Parameters<typeof runLocal>[0]["resume"],
    ) => {
      const provider = createTracerProvider(new SimpleSpanProcessor({ exporter }));
      return runLocal({
        agent: { spec },
        input: "go",
        tenantId: "demo-cricket",
        runId: "traced-run",
        tools: [save],
        client: createScriptedModel(script),
        models: scriptedModelConfig(),
        responder: async () => ({ pending: true }),
        runsDir,
        outputs: createMemoryOutputStore(),
        store,
        sinks: [createTracingSink(provider.getTracer("test"))],
        ...(resume ? { resume } : {}),
      });
    };

    const before = new InMemorySpanExporter();
    const first = await invoke(before, [
      { toolCalls: [{ name: "draft.save", arguments: { text: "hi" } }] },
    ]);
    expect(first.status).toBe("waiting");

    // a new process: a new tracing sink that never saw `run.started`
    const after = new InMemorySpanExporter();
    const second = await invoke(after, [{ content: "done" }], {
      reason: "answered",
      decision: approve("editor"),
    });
    expect(second.status).toBe("completed");
    const spans = after.getFinishedSpans();
    const root = spans.find((s) => s.name === "traced");
    expect(root?.attributes).toMatchObject({
      "langfuse.session.id": "traced-run",
      "langfuse.observation.metadata.resumed_reason": "answered",
      "langfuse.observation.metadata.status": "completed",
    });
    expect(spans.map((s) => s.name).sort()).toEqual(["call-model", "traced", "draft.save"].sort());
  });

  it("is off unless both Langfuse keys are set", () => {
    expect(langfuseExporter({})).toBeUndefined();
    expect(langfuseExporter({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeUndefined();
    expect(
      langfuseExporter({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }),
    ).toBeDefined();
  });
});
