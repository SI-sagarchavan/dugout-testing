import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDefinition,
  type AgentSpec,
  approve,
  defineTool,
  type InterruptRequest,
  type ModelClient,
  type RunEvent,
  reject,
  requestChange,
  type ToolContext,
} from "@dugout/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  type ModelConfig,
  type Responder,
  runLocal,
  type ScriptStep,
  SpecError,
  scriptedModelConfig,
  TransientModelError,
} from "../src/index.ts";

const seen: ToolContext[] = [];

const statsGet = defineTool({
  name: "stats.get",
  description: "Team stats",
  input: z.object({ team: z.string() }),
  effect: "read",
  timeoutMs: 1_000,
  async run({ team }, ctx) {
    seen.push(ctx);
    return { team, wins: 7, contact: "press@example.com" };
  },
});

const saved: unknown[] = [];
const draftSave = defineTool({
  name: "draft.save",
  description: "Save a draft",
  input: z.object({ text: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  async run(input) {
    saved.push(input);
    return { saved: true };
  },
});

const flakySave = defineTool({
  name: "flaky.save",
  description: "A write that fails",
  input: z.object({ text: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  async run() {
    throw new Error("disk full");
  },
});

/** Fails for text that starts with "bad", so a test can mix failures and successes. */
const maybeSave = defineTool({
  name: "maybe.save",
  description: "A write that fails for some input",
  input: z.object({ text: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  async run({ text }) {
    if (text.startsWith("bad")) throw new Error("rejected by the store");
    return { saved: true };
  },
});

let slowAttempts = 0;
const slowRead = defineTool({
  name: "slow.read",
  description: "Never finishes in time",
  input: z.object({}),
  effect: "read",
  timeoutMs: 20,
  retries: 1,
  run: () => {
    slowAttempts++;
    return new Promise(() => {});
  },
});

const bigRead = defineTool({
  name: "big.read",
  description: "Large output",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  run: async () => `${"x".repeat(20_000)}END`,
});

const wholeRead = defineTool({
  name: "whole.read",
  description: "Large output the model needs whole",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  alwaysInline: true,
  run: async () => `${"x".repeat(20_000)}END`,
});

/** Not ready until it has been asked three times, as a gate that wants something done first. */
let gatedAsks = 0;
const gatedRead = defineTool({
  name: "gated.read",
  description: "A read that says not yet while the run still has something to do",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  advisoryBlock: true,
  block: () => (++gatedAsks <= 2 ? "Not ready: do the other thing first" : undefined),
  run: async () => ({ ready: true }),
});

/** Spends like a child run would, and keeps what it was told about the run's budget. */
const spendCalls: Array<{
  callId?: string | undefined;
  usdLeft?: number | undefined;
  depth?: number | undefined;
}> = [];
const spendRead = defineTool({
  name: "spend.read",
  description: "A read that spends, like a child run",
  input: z.object({ usd: z.number() }),
  effect: "read",
  timeoutMs: 1_000,
  async run({ usd }, ctx) {
    spendCalls.push({ callId: ctx.callId, usdLeft: ctx.usdLeft, depth: ctx.depth });
    ctx.spend?.({
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      costUsd: usd,
      budgetCostUsd: usd,
      steps: 2,
    });
    return { ok: true };
  },
});

const spec = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "test-agent",
  version: 1,
  owner: "tests",
  instructions: "You are a test agent.",
  tools: ["stats.get", "draft.save", "slow.read", "big.read"],
  skills: [],
  onDemandSkills: [],
  model: "nova-lite",
  memory: { read: [], write: [] },
  budget: { usdPerRun: 1, maxSteps: 6, maxDepth: 0 },
  approvals: [],
  ...overrides,
});

const Output = z.object({ summary: z.string() });
const final = (summary: unknown) => ({ toolCalls: [{ name: "final", arguments: { summary } }] });
const call = (name: string, args: unknown = {}) => ({ toolCalls: [{ name, arguments: args }] });

let runsDir: string;
let approvals: InterruptRequest[];
const approveAll: Responder = async (req) => {
  approvals.push(req);
  return approve("tester");
};

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "dugout-runs-"));
  approvals = [];
  seen.length = 0;
  saved.length = 0;
  slowAttempts = 0;
  gatedAsks = 0;
  spendCalls.length = 0;
});

async function run(
  script: ScriptStep[],
  opts: {
    agent?: AgentDefinition;
    responder?: Responder;
    input?: unknown;
    models?: ModelConfig;
  } = {},
) {
  const sink = createMemorySink();
  const model = createScriptedModel(script);
  const result = await runLocal({
    agent: opts.agent ?? { spec: spec(), output: Output },
    input: opts.input ?? "Write a preview",
    tenantId: "demo-cricket",
    tools: [
      statsGet,
      draftSave,
      slowRead,
      bigRead,
      wholeRead,
      flakySave,
      maybeSave,
      spendRead,
      gatedRead,
    ],
    client: model,
    models: opts.models ?? scriptedModelConfig(),
    responder: opts.responder ?? approveAll,
    runsDir,
    sinks: [sink],
    outputs: createMemoryOutputStore(),
  });
  const types = sink.events.map((e) => e.type);
  const of = <T extends RunEvent["type"]>(type: T) =>
    sink.events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
  return { result, events: sink.events, types, of, model };
}

describe("runAgent", () => {
  it("completes through the final tool after using a tool", async () => {
    const { result, types, model } = await run([
      { reasoning: "need stats", ...call("stats.get", { team: "Lions" }) },
      final("Lions have won 7"),
    ]);

    expect(result).toMatchObject({ status: "completed", output: { summary: "Lions have won 7" } });
    expect(types).toEqual([
      "run.started",
      // each call's arguments stream while the model writes them, `final` included
      "tool.input.delta",
      "step.completed",
      "tool.started",
      "tool.completed",
      "tool.input.delta",
      "step.completed",
      "run.completed",
    ]);
    const second = model.requests[1]?.messages ?? [];
    expect(second.at(-2)).toMatchObject({ role: "assistant", reasoning: "need stats" });
    expect(second.at(-1)).toMatchObject({ role: "tool", toolCallId: "call_1_0" });
    expect(model.requests[0]?.model).toBe("nova-lite");
    expect(model.requests[0]?.tools.map((t) => t.name)).toEqual([
      "stats.get",
      "draft.save",
      "slow.read",
      "big.read",
      "run.readOutput",
      "ask",
      "final",
    ]);
  });

  it("completes with the message text when the agent has no output schema", async () => {
    const { result, of } = await run([{ content: "Done." }], { agent: { spec: spec() } });
    expect(result).toMatchObject({ status: "completed", output: "Done." });
    expect(of("token").map((e) => e.data.text)).toEqual(["Done."]);
  });

  it("gives tools the tenant from the run context", async () => {
    await run([call("stats.get", { team: "Lions" }), final("ok")]);
    expect(seen[0]).toMatchObject({ tenantId: "demo-cricket" });
  });

  it.each([
    ["registry", "nope.tool", { team: "x" }, "unknown tool"],
    ["policy", "stats.get", "{not json", "not valid JSON"],
    ["policy", "stats.get", { team: 3 }, "team"],
    ["policy", "stats.get", { team: "../../etc/passwd" }, "path traversal"],
    [
      "policy",
      "stats.get",
      { team: "x", tenantId: "demo-football" },
      "tenant is set by the harness",
    ],
    ["policy", "stats.get", { team: "sk-abcdefghijklmnopqrstuvwx" }, "secret"],
  ])("denies at the %s stage: %s %j", async (stage, name, args, reason) => {
    const { result, of, model } = await run([call(name, args), final("ok")]);
    const denied = of("tool.denied")[0];
    expect(denied?.data.stage).toBe(stage);
    expect(denied?.data.reason).toContain(reason);
    expect(model.requests[1]?.messages.at(-1)?.content).toMatch(/^Denied/);
    expect(result.status).toBe("completed");
  });

  it("stops when a refused call is sent again unchanged", async () => {
    const { result, of } = await run([
      call("stats.get", { team: 3, note: "a" }),
      call("stats.get", { note: "a", team: 3 }),
      final("ok"),
    ]);
    expect(of("tool.denied")).toHaveLength(2);
    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid_output",
      message: "stats.get was refused, and the same call was sent again unchanged",
    });
  });

  it("lets a tool's advisory gate refuse the same call again without ending the run", async () => {
    const { result, of } = await run(
      [call("gated.read"), call("gated.read"), call("gated.read"), final("ok")],
      { agent: { spec: spec({ tools: ["gated.read"] }), output: Output } },
    );
    expect(of("tool.denied")).toHaveLength(2);
    expect(of("tool.denied")[0]?.data.reason).toContain("Not ready");
    expect(result.status).toBe("completed");
  });

  it("accepts a corrected call after a refusal", async () => {
    const { result, of } = await run([
      call("stats.get", { team: 3 }),
      call("stats.get", { team: "Lions" }),
      final("ok"),
    ]);
    expect(of("tool.denied")).toHaveLength(1);
    expect(result.status).toBe("completed");
  });

  it("denies a registered tool the spec does not allow", async () => {
    const { of } = await run([call("big.read"), final("ok")], {
      agent: { spec: spec({ tools: ["stats.get"] }), output: Output },
    });
    expect(of("tool.denied")[0]?.data).toMatchObject({ stage: "spec", tool: "big.read" });
  });

  it("waits for approval before a write tool, then runs it", async () => {
    const { types, of } = await run([call("draft.save", { text: "hello" }), final("saved")]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.input).toEqual({ text: "hello" });
    expect(saved).toEqual([{ text: "hello" }]);
    expect(types.slice(3, 7)).toEqual([
      "question.asked",
      "question.answered",
      "tool.started",
      "tool.completed",
    ]);
    expect(of("question.answered")[0]?.data.by).toBe("tester");
  });

  it("asks for approval on a read tool listed in approvals", async () => {
    await run([call("stats.get", { team: "x" }), final("ok")], {
      agent: { spec: spec({ approvals: ["stats.get"] }), output: Output },
    });
    expect(approvals.map((a) => a.tool)).toEqual(["stats.get"]);
  });

  it("ends the run without writing when the approval is rejected", async () => {
    const { result, types } = await run([call("draft.save", { text: "bad" })], {
      responder: async () => reject("editor", "too long"),
    });
    expect(saved).toEqual([]);
    expect(result).toMatchObject({
      status: "rejected",
      output: { tool: "draft.save", input: { text: "bad" }, by: "editor", reason: "too long" },
    });
    expect(types.slice(-2)).toEqual(["question.answered", "run.completed"]);
  });

  it("sends requested changes back to the model in the same run, then runs the new call", async () => {
    let asked = 0;
    const { result, of, model } = await run(
      [
        call("draft.save", { text: "Lions win" }),
        call("draft.save", { text: "Lions draw" }),
        final("saved"),
      ],
      {
        responder: async (req) => {
          approvals.push(req);
          return asked++ === 0 ? requestChange("editor", "Say draw, not win.") : approve("editor");
        },
      },
    );
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(saved).toEqual([{ text: "Lions draw" }]);
    expect(of("question.answered")[0]?.data).toMatchObject({
      tool: "draft.save",
      by: "editor",
      answers: { review: { decision: "change", comment: "Say draw, not win." } },
    });

    // one transcript: the first call, a tool result saying it did not run, then the reviewer
    // speaking as the user (agents never take instructions from tool results)
    const second = model.requests[1]?.messages ?? [];
    expect(JSON.stringify(second)).toContain("Lions win");
    expect(second.at(-2)).toMatchObject({
      role: "tool",
      content: "Not run: the reviewer sent draft.save back with a change request.",
    });
    expect(second.at(-1)?.role).toBe("user");
    expect(second.at(-1)?.content).toContain('"Say draw, not win."');
    expect(second.at(-1)?.content).toContain("keep everything else exactly as it was");
  });

  it("runs nothing else from a turn whose write was sent back for changes, not even final", async () => {
    const { result, model } = await run(
      [
        {
          toolCalls: [
            { name: "draft.save", arguments: { text: "a" } },
            { name: "final", arguments: { summary: "early" } },
          ],
        },
        call("draft.save", { text: "b" }),
        final("saved"),
      ],
      {
        responder: async () =>
          approvals.push({} as InterruptRequest) === 1
            ? requestChange("editor", "Use b.")
            : approve("editor"),
      },
    );
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(saved).toEqual([{ text: "b" }]);
    const messages = model.requests[1]?.messages ?? [];
    expect(messages.at(-2)?.content).toBe(
      "Not run: the reviewer asked for changes to an earlier call in this turn.",
    );
    expect(messages.at(-1)?.role).toBe("user");
  });

  it("does not let the run finish until the reviewer approves the change", async () => {
    const { result, model } = await run(
      [
        call("draft.save", { text: "a" }),
        final("gave up"),
        { content: "I would rather stop here." },
        call("draft.save", { text: "b" }),
        final("saved"),
      ],
      {
        responder: async () =>
          approvals.push({} as InterruptRequest) === 1
            ? requestChange("editor", "Use b.")
            : approve("editor"),
      },
    );
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(saved).toEqual([{ text: "b" }]);
    const afterFinal = model.requests[2]?.messages ?? [];
    expect(afterFinal.at(-2)?.content).toBe(
      "Not accepted: the reviewer has not approved the changes they asked for.",
    );
    expect(afterFinal.at(-1)?.content).toContain('"Use b."');
    expect(model.requests[3]?.messages.at(-1)?.content).toContain('"Use b."');
  });

  it("fails if the model keeps trying to finish without making the change", async () => {
    const { result } = await run(
      [call("draft.save", { text: "a" }), final("x"), final("x"), final("x")],
      { responder: async () => requestChange("editor", "Use b.") },
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid_output",
      message: "ended without making the changes the reviewer asked for",
    });
    expect(saved).toEqual([]);
  });

  it("does not restate a change that was approved later in the same turn", async () => {
    const { result, model, of } = await run(
      [
        call("draft.save", { text: "a" }),
        {
          toolCalls: [
            { name: "final", arguments: { summary: "early" } },
            { name: "draft.save", arguments: { text: "b" } },
          ],
        },
        final("saved"),
      ],
      {
        responder: async () =>
          approvals.push({} as InterruptRequest) === 1
            ? requestChange("editor", "Use b.")
            : approve("editor"),
      },
    );
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(saved).toEqual([{ text: "b" }]);
    // the turn ends with the save's result, not a stale "please change this"
    const last = model.requests[2]?.messages.at(-1);
    expect(last?.role).toBe("tool");
    expect(JSON.stringify(model.requests[2]?.messages.slice(-2))).not.toContain("Use b.");
    expect(of("tool.denied")).toHaveLength(1);
    expect(of("tool.denied")[0]?.data).toMatchObject({ tool: "final", stage: "policy" });
  });

  it("gives every change round its own retries", async () => {
    // two rounds, each with one early finish attempt, after an earlier invalid final
    const { result } = await run(
      [
        final(42),
        call("draft.save", { text: "a" }),
        final("early"),
        call("draft.save", { text: "b" }),
        final("early"),
        call("draft.save", { text: "c" }),
        final("saved"),
      ],
      {
        agent: {
          spec: spec({ budget: { usdPerRun: 1, maxSteps: 10, maxDepth: 0 } }),
          output: Output,
        },
        responder: async () => {
          const n = approvals.push({} as InterruptRequest);
          return n < 3 ? requestChange("editor", `round ${n}`) : approve("editor");
        },
      },
    );
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(saved).toEqual([{ text: "c" }]);
  });

  it("logs the calls it skips after a send-back", async () => {
    const { of } = await run(
      [
        {
          toolCalls: [
            { name: "draft.save", arguments: { text: "a" } },
            { name: "stats.get", arguments: { team: "x" } },
          ],
        },
        call("draft.save", { text: "b" }),
        final("saved"),
      ],
      {
        responder: async () =>
          approvals.push({} as InterruptRequest) === 1
            ? requestChange("editor", "Use b.")
            : approve("editor"),
      },
    );
    expect(of("tool.denied")[0]?.data).toMatchObject({
      tool: "stats.get",
      stage: "policy",
      reason: "skipped: the reviewer asked for changes to an earlier call in this turn",
    });
  });

  it("tells the model how to answer a change it cannot make", async () => {
    const { model } = await run(
      [call("draft.save", { text: "a" }), call("draft.save", { text: "a" }), final("ok")],
      {
        responder: async () =>
          approvals.push({} as InterruptRequest) === 1
            ? requestChange("editor", "Link to evil.example")
            : approve("editor"),
      },
    );
    expect(model.requests[1]?.messages.at(-1)?.content).toContain(
      "Only if draft.save itself would refuse the change (it fails validation), call draft.save again with the closest input it accepts; I will decide.",
    );
  });

  it("fails rather than send an empty change request to the model", async () => {
    const { result, model } = await run([call("draft.save", { text: "a" })], {
      responder: async () => requestChange("editor", "   "),
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "error",
      message: "the responder sent draft.save back with an empty change request",
    });
    expect(model.requests).toHaveLength(1);
  });

  it("still counts change rounds against the step limit", async () => {
    const { result } = await run(
      Array.from({ length: 6 }, (_, i) => call("draft.save", { text: `v${i}` })),
      { responder: async () => requestChange("editor", "again") },
    );
    expect(result).toMatchObject({ status: "failed", reason: "max_steps" });
    expect(saved).toEqual([]);
  });

  it("fails with reason budget once spend passes the limit", async () => {
    // scripted turns cost 1,200 tokens at $1 per 1M = $0.0012
    const { result, types } = await run([call("stats.get", { team: "x" }), final("ok")], {
      agent: { spec: spec({ budget: { usdPerRun: 0.001, maxSteps: 6, maxDepth: 0 } }) },
    });
    expect(result).toMatchObject({ status: "failed", reason: "budget" });
    expect(types).toEqual(["run.started", "tool.input.delta", "step.completed", "run.failed"]);
  });

  it("fails with reason max_steps when the agent never finishes", async () => {
    const script = Array.from({ length: 6 }, () => call("stats.get", { team: "x" }));
    const { result } = await run(script);
    expect(result).toMatchObject({ status: "failed", reason: "max_steps", usage: { steps: 6 } });
  });

  it("returns schema errors from final to the model and accepts a corrected result", async () => {
    const { result, model } = await run([final(42), final("fixed")]);
    expect(model.requests[1]?.messages.at(-1)?.content).toMatch(/^Invalid result/);
    expect(result).toMatchObject({ status: "completed", output: { summary: "fixed" } });
  });

  it("reminds the agent to call final, then fails after repeated invalid output", async () => {
    const { result, model } = await run([{ content: "here you go" }, final(1), final(2)]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Call the final tool with your result.",
    });
    expect(result).toMatchObject({ status: "failed", reason: "invalid_output" });
  });

  it("says what the model said instead, when it keeps ending its turn without a final", async () => {
    const asked = "I cannot build this without the showcase id. Please give me it.";
    const { result } = await run([
      { content: asked },
      { content: asked },
      { content: asked },
      { content: asked },
    ]);
    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid_output",
      message: `ended without calling final: ${asked}`,
    });
  });

  it("retries a reply cut off at max_tokens, then completes on the next good turn", async () => {
    const { result, model } = await run(
      [
        { content: "The match begins at", finishReason: "max_tokens" },
        { content: "A full preview.", finishReason: "end_turn" },
      ],
      { agent: { spec: spec() } },
    );
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringMatching(/cut off/),
    });
    expect(result).toMatchObject({ status: "completed", output: "A full preview." });
  });

  it("fails with reason model_stop after three cut-off turns in a row", async () => {
    const cut = { content: "The match", finishReason: "max_tokens" };
    const { result, model } = await run([cut, cut, cut, final("never")]);
    expect(model.requests).toHaveLength(3);
    expect(result).toMatchObject({ status: "failed", reason: "model_stop" });
    expect((result as { message: string }).message).toContain("max_tokens");
  });

  it("never runs a call from a cut-off turn, even a write that parses", async () => {
    const { result, model, of } = await run(
      [{ ...call("draft.save", { text: "hi" }), finishReason: "max_tokens" }, final("ok")],
      { agent: { spec: spec({ approvals: ["effect:write"] }), output: Output } },
    );
    expect(approvals).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(of("tool.denied")).toHaveLength(1);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Not run: your reply was cut off (max_tokens). Send it again, shorter.",
    });
    expect(result.status).toBe("completed");
  });

  it("fails at once on content_filtered and runs none of its tool calls", async () => {
    const { result, model } = await run([
      { ...call("stats.get", { team: "x" }), finishReason: "content_filtered" },
      final("ok"),
    ]);
    expect(model.requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "failed", reason: "model_stop" });
    expect((result as { message: string }).message).toContain("content_filtered");
    expect(seen).toHaveLength(0);
  });

  const withFlaky = {
    agent: { spec: spec({ tools: ["stats.get", "flaky.save"] }), output: Output },
  };

  it("does not accept final in the turn of a failed call, and accepts it the next turn", async () => {
    const { result, model } = await run(
      [
        {
          toolCalls: [
            { name: "flaky.save", arguments: { text: "a" } },
            { name: "final", arguments: { summary: "saved" } },
          ],
        },
        final("saved"),
      ],
      withFlaky,
    );
    expect(model.requests).toHaveLength(2);
    const tools = model.requests[1]?.messages.filter((m) => m.role === "tool");
    expect(tools?.at(-1)?.content).toBe(
      "Not accepted: flaky.save failed in this turn. Deal with that before calling final.",
    );
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
  });

  it("counts final after a failed call against the invalid output limit", async () => {
    const both = {
      toolCalls: [
        { name: "flaky.save", arguments: { text: "a" } },
        { name: "final", arguments: { summary: "saved" } },
      ],
    };
    const { result } = await run([both, both, both, final("x")], withFlaky);
    expect(result).toMatchObject({ status: "failed", reason: "invalid_output" });
  });

  it("refuses a final that verifyFinal rejects, then accepts a corrected one", async () => {
    const { result, model } = await run([final("draft"), final("approved")], {
      agent: {
        spec: spec(),
        output: Output,
        verifyFinal: (out) =>
          (out as { summary: string }).summary === "draft" ? "still a draft" : undefined,
      },
    });
    expect(model.requests[1]?.messages.at(-1)?.content).toBe("Not accepted: still a draft");
    expect(result).toMatchObject({ status: "completed", output: { summary: "approved" } });
  });

  it("lets completeFinal rewrite the output before verifyFinal sees it", async () => {
    const { result } = await run([final("draft")], {
      agent: {
        spec: spec(),
        output: Output,
        completeFinal: () => ({ summary: "approved" }),
        verifyFinal: (out) =>
          (out as { summary: string }).summary === "draft" ? "still a draft" : undefined,
      },
    });
    expect(result).toMatchObject({ status: "completed", output: { summary: "approved" } });
  });

  it("hands verifyFinal the unwrapped output, the context and the transcript", async () => {
    const calls: unknown[] = [];
    const Union = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]);
    await run([{ toolCalls: [{ name: "final", arguments: { result: { a: "x" } } }] }], {
      agent: {
        spec: spec(),
        output: Union,
        verifyFinal: (out, r) => {
          calls.push(out, r.ctx.tenantId, r.messages.length);
          return undefined;
        },
      },
    });
    expect(calls).toEqual([{ a: "x" }, "demo-cricket", 3]);
  });

  describe("tool results that are errors", () => {
    const toolMessages = (
      model: { requests: Array<{ messages: Array<{ role: string }> }> },
      at: number,
    ) =>
      (model.requests[at]?.messages ?? []).filter((m) => m.role === "tool") as unknown as Array<{
        content: string;
        isError?: boolean;
      }>;

    it("marks a denial, a failed tool, an invalid final and a refused final", async () => {
      const withFlaky = {
        agent: { spec: spec({ tools: ["stats.get", "flaky.save"] }), output: Output },
      };
      const denied = await run([call("stats.get", { team: 3 }), final("ok")], withFlaky);
      expect(toolMessages(denied.model, 1)[0]).toMatchObject({ isError: true });

      const failed = await run([call("flaky.save", { text: "a" }), final("ok")], withFlaky);
      expect(toolMessages(failed.model, 1)[0]).toMatchObject({
        content: "Error: disk full",
        isError: true,
      });

      const invalid = await run([final(42), final("ok")]);
      expect(toolMessages(invalid.model, 1)[0]).toMatchObject({ isError: true });

      const verified = await run([final("a"), final("b")], {
        agent: {
          spec: spec(),
          output: Output,
          verifyFinal: (o) => ((o as { summary: string }).summary === "a" ? "no" : undefined),
        },
      });
      expect(toolMessages(verified.model, 1)[0]).toMatchObject({ isError: true });

      const skipped = await run([
        { ...call("stats.get", { team: "x" }), finishReason: "max_tokens" },
        final("ok"),
      ]);
      expect(toolMessages(skipped.model, 1)[0]).toMatchObject({ isError: true });
    });

    it("leaves a successful result unmarked", async () => {
      const { model } = await run([call("stats.get", { team: "x" }), final("ok")]);
      expect(toolMessages(model, 1)[0]).not.toHaveProperty("isError");
    });
  });

  describe("repeated failing calls", () => {
    const agent = (maxSteps = 10) => ({
      agent: {
        spec: spec({ tools: ["maybe.save"], budget: { usdPerRun: 1, maxSteps, maxDepth: 0 } }),
        output: Output,
      },
    });
    const save = (text: string) => call("maybe.save", { text });

    it("ends the run at the third identical failure, not at maxSteps", async () => {
      const { result, model, of } = await run(
        [save("bad"), save("bad"), save("bad"), save("bad"), final("x")],
        agent(),
      );
      expect(model.requests).toHaveLength(3);
      expect(of("tool.completed")).toHaveLength(3);
      expect(result).toMatchObject({
        status: "failed",
        reason: "invalid_output",
        message: "maybe.save failed 3 times with the same input",
      });
    });

    it("counts the same input whatever the key order", async () => {
      const { result } = await run(
        [
          call("maybe.save", { text: "bad", extra: 1 }),
          call("maybe.save", { extra: 1, text: "bad" }),
          call("maybe.save", { text: "bad", extra: 1 }),
        ],
        agent(),
      );
      expect(result).toMatchObject({ status: "failed" });
    });

    it("starts again from one on a different input or after a success", async () => {
      const { result } = await run(
        [
          save("bad1"),
          save("bad1"),
          save("bad2"),
          save("bad2"),
          save("good"),
          save("bad2"),
          save("bad2"),
          final("ok"),
        ],
        agent(),
      );
      expect(result.status).toBe("completed");
    });
  });

  describe("finishing", () => {
    const read = call("stats.get", { team: "x" });
    const forced = () => {
      const config = scriptedModelConfig();
      const entry = config.models["nova-lite"] as ModelConfig["models"][string];
      return {
        models: { models: { ...config.models, "nova-lite": { ...entry, forcedTools: true } } },
      };
    };
    const warning = (m: { role: string; content: string }) =>
      m.content.startsWith("2 model turns left");

    it("warns once, two turns before the step limit, and saves it in the transcript", async () => {
      // maxSteps is 6: the warning goes in before turn 5
      const { model } = await run([read, read, read, read, read, read]);
      const warned = model.requests.map((r) => r.messages.filter(warning).length);
      expect(warned).toEqual([0, 0, 0, 0, 1, 1]);
      const text = model.requests[4]?.messages.find(warning)?.content;
      expect(text).toBe("2 model turns left. Finish now.\nCall final with your result.");
      // the later request holds the same message in the same place
      expect(model.requests[5]?.messages.slice(0, model.requests[4]?.messages.length)).toEqual(
        model.requests[4]?.messages,
      );
    });

    it("leaves out the call-final line when the agent has no output schema", async () => {
      const { model } = await run([read, read, read, read, read, read], {
        agent: { spec: spec() },
      });
      expect(model.requests[4]?.messages.find(warning)?.content).toBe(
        "2 model turns left. Finish now.",
      );
    });

    // an agent that never writes, so there is nothing a forced answer could skip
    const readOnly = () => ({
      spec: spec({ tools: ["stats.get", "slow.read", "big.read"] }),
      output: Output,
    });

    it("forces final on the last step for a model with forcedTools, and not otherwise", async () => {
      const script = [read, read, read, read, read, final("ok")];
      const on = await run(script, { ...forced(), agent: readOnly() });
      expect(on.model.requests.map((r) => r.toolChoice)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { tool: "final" },
      ]);
      const off = await run(script, { agent: readOnly() });
      expect(off.model.requests.some((r) => r.toolChoice)).toBe(false);
    });

    it("forces final on the turn after the call-final nudge", async () => {
      const { model, result } = await run([{ content: "here you go" }, final("ok")], {
        ...forced(),
        agent: readOnly(),
      });
      expect(model.requests[0]?.toolChoice).toBeUndefined();
      expect(model.requests[1]?.toolChoice).toEqual({ tool: "final" });
      expect(result.status).toBe("completed");
    });

    describe("an agent that is expected to write", () => {
      const save = call("draft.save", { text: "a" });

      it("leaves the choice open after the nudge until something has been saved", async () => {
        // the model says what it will do, instead of doing it: forcing `final` here would end the
        // run completed with nothing saved and no approval ever asked for
        const { model, result } = await run(
          [{ content: "Now I'll save it." }, save, final("ok")],
          forced(),
        );
        expect(model.requests[1]?.toolChoice).toBeUndefined();
        expect(result.status).toBe("completed");
      });

      it("forces final on the nudge once the write has happened", async () => {
        const { model } = await run([save, { content: "all done" }, final("ok")], forced());
        expect(model.requests[2]?.toolChoice).toEqual({ tool: "final" });
      });

      it("does not force the last step before a write, so the run fails instead of faking one", async () => {
        const { model, result } = await run([read, read, read, read, read, read], forced());
        expect(model.requests.some((r) => r.toolChoice)).toBe(false);
        expect(result.status).toBe("failed");
      });

      it("forces final when the agent says this run is not expected to write", async () => {
        const { model } = await run([{ content: "here you go" }, final("ok")], {
          ...forced(),
          agent: { spec: spec(), output: Output, writeExpected: () => false },
        });
        expect(model.requests[1]?.toolChoice).toEqual({ tool: "final" });
      });
    });
  });

  it("reports a tool timeout as a failed call after its retries", async () => {
    const { of, result } = await run([call("slow.read"), final("ok")]);
    expect(slowAttempts).toBe(2);
    expect(of("tool.completed")[0]?.data).toMatchObject({ ok: false });
    expect(of("tool.completed")[0]?.data.content).toContain("timed out after 20ms");
    expect(result.status).toBe("completed");
  });

  it("replaces a large output with a reference the agent can read back", async () => {
    let ref = "";
    const { model } = await run([
      call("big.read"),
      (req) => {
        ref = JSON.parse(req.messages.at(-1)?.content ?? "{}").ref;
        return call("run.readOutput", { ref, offset: 19_998 });
      },
      final("ok"),
    ]);
    const truncated = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? "{}");
    expect(truncated).toMatchObject({ ref: "out-1", chars: 20_003 });
    expect(truncated.preview).toHaveLength(1_000);
    expect(model.requests[2]?.messages.at(-1)?.content).toBe("xxEND");
  });

  it("wraps an output of several shapes for the model and returns it unwrapped", async () => {
    const Variant = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("page"), slug: z.string() }),
      z.object({ kind: z.literal("menu"), items: z.array(z.string()) }),
    ]);
    const agent = { spec: spec(), output: Variant };
    const { result, model } = await run(
      [
        {
          toolCalls: [{ name: "final", arguments: { result: { kind: "menu", items: ["Home"] } } }],
        },
      ],
      { agent },
    );
    expect(result).toMatchObject({
      status: "completed",
      output: { kind: "menu", items: ["Home"] },
    });
    const finalTool = model.requests[0]?.tools.find((t) => t.name === "final");
    expect(finalTool?.parameters).toMatchObject({ type: "object", required: ["result"] });

    // a list is wrapped the same way
    const list = await run(
      [{ toolCalls: [{ name: "final", arguments: { result: ["a", "b"] } }] }],
      { agent: { spec: spec(), output: z.array(z.string()) } },
    );
    expect(list.result).toMatchObject({ status: "completed", output: ["a", "b"] });
  });

  it("keeps a large output whole when its tool needs it all", async () => {
    const agent = { spec: spec({ tools: ["whole.read"] }), output: Output };
    const { model } = await run([call("whole.read"), final("ok")], { agent });
    expect(model.requests[1]?.messages.at(-1)?.content).toBe(`${"x".repeat(20_000)}END`);
  });

  it("redacts PII in tool output before the model and the event log see it", async () => {
    const { model, of } = await run([call("stats.get", { team: "x" }), final("ok")]);
    const toolMessage = model.requests[1]?.messages.at(-1)?.content ?? "";
    expect(toolMessage).toContain("[REDACTED:email]");
    expect(toolMessage).not.toContain("press@example.com");
    expect(JSON.stringify(of("tool.completed"))).not.toContain("press@example.com");
  });

  it("writes every event to the run's events.jsonl in seq order", async () => {
    const { result, events } = await run([final("ok")]);
    const lines = (await readFile(join(runsDir, result.runId, "events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const logged = lines.map((line) => JSON.parse(line) as RunEvent);
    expect(logged.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(logged.map((e) => e.runId))).toEqual(new Set([result.runId]));
  });

  it("fails with reason error when the model call throws", async () => {
    const { result } = await run([]);
    expect(result).toMatchObject({ status: "failed", reason: "error" });
    expect((result as { message: string }).message).toContain("script exhausted");
  });

  it.each([
    ["memory without context", spec({ memory: { read: ["semantic"], write: [] } })],
    ["skills without context", spec({ skills: ["x"] })],
    ["skills to load without context", spec({ onDemandSkills: ["x"] })],
    ["agents without depth", spec({ agents: ["helper"] })],
    ["unknown tool", spec({ tools: ["missing.tool"] })],
    ["reserved", spec({ tools: ["final"] })],
    ["approval", spec({ approvals: ["missing.tool"] })],
  ])("rejects an unsupported spec (%s) before the run starts", async (_, bad) => {
    await expect(run([final("ok")], { agent: { spec: bad } })).rejects.toBeInstanceOf(SpecError);
  });
});

describe("what a tool call spends (ADR 0025)", () => {
  const spends = spec({
    tools: ["spend.read"],
    budget: { usdPerRun: 0.01, maxSteps: 6, maxDepth: 0 },
  });

  it("tells the call what the run has left, and counts what it spent against the budget", async () => {
    const { result, of } = await run([call("spend.read", { usd: 0.004 }), final("done")], {
      agent: { spec: spends, output: Output },
    });
    expect(result.status).toBe("completed");
    // one scripted turn ($0.0012) before the call; the call's id names a child run after it
    expect(spendCalls).toEqual([{ callId: "call_1_0", usdLeft: 0.01 - 0.0012, depth: 0 }]);
    // two turns of the run, and the call's spend; its turns are not the run's
    expect(result.usage.costUsd).toBeCloseTo(2 * 0.0012 + 0.004, 6);
    expect(result.usage.steps).toBe(2);
    expect(result.usage.inputTokens).toBe(2 * 1_000 + 100);
    expect(of("tool.completed")[0]?.data.usage?.costUsd).toBe(0.004);
  });

  it("ends the run over budget as soon as a call's spend takes it there", async () => {
    const { result, model } = await run([call("spend.read", { usd: 0.02 }), final("done")], {
      agent: { spec: spends, output: Output },
    });
    expect(result).toMatchObject({ status: "failed", reason: "budget" });
    // no turn after the call that spent too much
    expect(model.requests).toHaveLength(1);
  });

  it("answers with its ending, and does nothing else, when resumed after it ended", async () => {
    const store = createMemoryRunStore();
    const sink = createMemorySink();
    const go = (script: ScriptStep[], resume?: { reason: "recovery" }) =>
      runLocal({
        agent: { spec: spec({ tools: ["stats.get"] }), output: Output },
        input: "Write a preview",
        tenantId: "demo-cricket",
        tools: [statsGet],
        client: createScriptedModel(script),
        models: scriptedModelConfig(),
        responder: approveAll,
        runsDir,
        sinks: [sink],
        outputs: createMemoryOutputStore(),
        runId: "ended-run",
        store,
        ...(resume ? { resume } : {}),
      });
    const first = await go([final("Lions have won 7")]);
    expect(first).toMatchObject({ status: "completed", output: { summary: "Lions have won 7" } });
    const emitted = sink.events.length;

    const again = await go([], { reason: "recovery" });
    expect(again).toMatchObject({ status: "completed", output: { summary: "Lions have won 7" } });
    expect(again.usage).toEqual(first.usage);
    expect(sink.events).toHaveLength(emitted);
  });
});

describe("model retries", () => {
  /** Fails with `errors` first, one per call, then answers from the script. */
  const flaky = (errors: Error[], script: ScriptStep[]): ModelClient & { calls: number } => {
    const inner = createScriptedModel(script);
    const client = {
      calls: 0,
      async complete(...args: Parameters<ModelClient["complete"]>) {
        client.calls++;
        const err = errors.shift();
        if (err) throw err;
        return inner.complete(...args);
      },
    };
    return client;
  };
  const go = async (client: ModelClient) => {
    const sink = createMemorySink();
    const delays: number[] = [];
    const result = await runLocal({
      agent: { spec: spec({ tools: ["stats.get"] }), output: Output },
      input: "Write a preview",
      tenantId: "demo-cricket",
      tools: [statsGet],
      client,
      models: scriptedModelConfig(),
      responder: approveAll,
      runsDir,
      sinks: [sink],
      outputs: createMemoryOutputStore(),
      retryDelayMs: (attempt) => {
        delays.push(attempt);
        return 0;
      },
    });
    return { result, delays, events: sink.events };
  };

  it("retries a transient error and completes with one step.completed", async () => {
    const throttle = () => new TransientModelError("Bedrock ThrottlingException: slow down");
    const client = flaky([throttle(), throttle()], [final("ok")]);
    const { result, delays, events } = await go(client);
    expect(result).toMatchObject({ status: "completed", output: { summary: "ok" } });
    expect(client.calls).toBe(3);
    expect(delays).toEqual([1, 2]);
    expect(events.filter((e) => e.type === "step.completed")).toHaveLength(1);
  });

  it("gives up after three retries", async () => {
    const throttle = () => new TransientModelError("Bedrock ThrottlingException: slow down");
    const client = flaky(
      [throttle(), throttle(), throttle(), throttle(), throttle()],
      [final("ok")],
    );
    const { result, delays } = await go(client);
    expect(client.calls).toBe(4);
    expect(delays).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ status: "failed", reason: "error" });
  });

  it("does not retry other errors", async () => {
    const client = flaky([new Error("Bedrock ValidationException: bad")], [final("ok")]);
    const { result } = await go(client);
    expect(client.calls).toBe(1);
    expect(result).toMatchObject({ status: "failed", reason: "error" });
  });
});

describe("runLocal hooks", () => {
  it("appends the memory context to the instructions and hands events to afterRun", async () => {
    const model = createScriptedModel([final("ok")]);
    const sink = createMemorySink();
    let after: { events: RunEvent[]; status: string } | undefined;
    const result = await runLocal({
      agent: {
        spec: spec({ skills: ["style"], memory: { read: ["semantic"], write: [] } }),
        output: Output,
      },
      input: "go",
      tenantId: "demo-cricket",
      tools: [statsGet, draftSave, slowRead, bigRead, wholeRead],
      client: model,
      models: scriptedModelConfig(),
      responder: approveAll,
      runsDir,
      sinks: [sink],
      outputs: createMemoryOutputStore(),
      context: async (ctx) => ({
        text: `## House facts\n- tenant ${ctx.tenantId}`,
        recalled: "<recalled_memory>\nToday is 2026-11-01.\n</recalled_memory>",
        tokens: 8,
        sources: [{ id: "m1", kind: "semantic", tokens: 8 }],
      }),
      afterRun: async ({ result, events }) => {
        after = { events, status: result.status };
      },
    });

    expect(result.status).toBe("completed");
    expect(model.requests[0]?.messages[0]?.content).toBe(
      "You are a test agent.\n\n## House facts\n- tenant demo-cricket",
    );
    // recalled memory leads the first user message, then a blank line and the input
    expect(model.requests[0]?.messages[1]?.content).toBe(
      "<recalled_memory>\nToday is 2026-11-01.\n</recalled_memory>\n\ngo",
    );
    expect(sink.events[1]).toMatchObject({
      type: "context.built",
      data: { tokens: 8, sources: [{ id: "m1" }] },
    });
    expect(after?.status).toBe("completed");
    expect(after?.events.map((e) => e.type)).toEqual(sink.events.map((e) => e.type));
  });

  it("reports an afterRun failure without failing the run", async () => {
    const result = await runLocal({
      agent: { spec: spec(), output: Output },
      input: "go",
      tenantId: "demo-cricket",
      tools: [statsGet, draftSave, slowRead, bigRead, wholeRead],
      client: createScriptedModel([final("ok")]),
      models: scriptedModelConfig(),
      responder: approveAll,
      runsDir,
      outputs: createMemoryOutputStore(),
      afterRun: async () => {
        throw new Error("consolidation down");
      },
    });
    expect(result).toMatchObject({ status: "completed", afterRunError: "consolidation down" });
  });
});
