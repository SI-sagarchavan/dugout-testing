import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDefinition,
  type AgentSpec,
  approve,
  defineHook,
  defineTool,
  type RunCheckpoint,
} from "@dugout/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  carryOverLegacyState,
  createHooks,
  createMemoryOutputStore,
  createMemoryRunStore,
  createScriptedModel,
  harnessHooks,
  runLocal,
  type ScriptStep,
  SpecError,
  scriptedModelConfig,
} from "../src/index.ts";

const ping = defineTool({
  name: "ping",
  description: "Answers",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  run: async () => "pong",
});

const spec = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "hooked",
  version: 1,
  owner: "tests",
  instructions: "You are a test agent.",
  tools: ["ping"],
  skills: [],
  onDemandSkills: [],
  model: "nova-lite",
  memory: { read: [], write: [] },
  budget: { usdPerRun: 1, maxSteps: 6, maxDepth: 0 },
  approvals: [],
  ...overrides,
});
const Output = z.object({ summary: z.string() });
const call = (name: string, args: unknown = {}) => ({ toolCalls: [{ name, arguments: args }] });
const final = (summary: string) => call("final", { summary });

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "dugout-hooks-"));
});

async function run(script: ScriptStep[], definition: Partial<AgentDefinition> = {}) {
  const store = createMemoryRunStore();
  const model = createScriptedModel(script);
  const result = await runLocal({
    agent: { spec: spec(), output: Output, ...definition },
    input: "go",
    tenantId: "demo-cricket",
    runId: "run-1",
    tools: [ping],
    client: model,
    models: scriptedModelConfig(),
    responder: async () => approve("tester"),
    runsDir,
    outputs: createMemoryOutputStore(),
    store,
  });
  const kept = store.runs.get("demo-cricket/run-1");
  return { result, model, messages: kept?.messages ?? [], points: kept?.points ?? [] };
}

describe("an agent's hooks", () => {
  it("changes what is sent to the model and leaves the saved transcript alone", async () => {
    const hint = defineHook({
      id: "hint",
      beforeModel: ({ messages }) => ({
        view: [...messages, { role: "user", content: "HINT: be brief" }],
      }),
    });
    const { result, model, messages } = await run([call("ping"), final("done")], {
      hooks: [hint],
    });

    expect(result).toMatchObject({ status: "completed" });
    for (const request of model.requests) {
      expect(request.messages.at(-1)).toEqual({ role: "user", content: "HINT: be brief" });
    }
    expect(JSON.stringify(messages)).not.toContain("HINT");
  });

  it("can add a message to the transcript, and it is saved", async () => {
    const reminder = defineHook({
      id: "reminder",
      beforeModel: ({ step }) =>
        step === 2 ? { append: [{ role: "user", content: "Reminder: keep going" }] } : undefined,
    });
    const { model, messages } = await run([call("ping"), final("done")], { hooks: [reminder] });

    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "Reminder: keep going",
    });
    expect(messages).toContainEqual({ role: "user", content: "Reminder: keep going" });
  });

  it("keeps its state in the checkpoint, so a resume starts from it", async () => {
    const counter = defineHook<{ turns: number }>({
      id: "counter",
      initial: { turns: 0 },
      beforeModel: (_event, state) => ({ state: { turns: state.turns + 1 } }),
    });
    const { points } = await run([call("ping"), final("done")], { hooks: [counter] });

    expect(points.at(-1)?.checkpoint.hooks).toEqual({ counter: { turns: 2 } });
    // every save point carries the state as it was then
    const seen = points.map((p) => (p.checkpoint.hooks?.counter as { turns: number })?.turns ?? 0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("can refuse a final, and the model is told why", async () => {
    const strict = defineHook({
      id: "strict",
      beforeFinal: ({ value }) =>
        (value as { summary: string }).summary === "first"
          ? { refuse: "say it better" }
          : undefined,
    });
    const { result, model } = await run([final("first"), final("second")], { hooks: [strict] });

    expect(result).toMatchObject({ status: "completed", output: { summary: "second" } });
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Not accepted: say it better",
    });
  });

  it("can end the run after a tool", async () => {
    const stopper = defineHook({
      id: "stopper",
      afterTool: (event) => (event.stage === "ran" ? { stop: "enough pings" } : undefined),
    });
    const { result } = await run([call("ping"), final("never")], { hooks: [stopper] });

    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid_output",
      message: "enough pings",
    });
  });

  it("fails the run, naming the hook, when it throws", async () => {
    const broken = defineHook({
      id: "broken",
      beforeModel: () => {
        throw new Error("no clock here");
      },
    });
    const { result } = await run([final("never")], { hooks: [broken] });

    expect(result).toMatchObject({ status: "failed", reason: "error" });
    expect((result as { message: string }).message).toContain("hook broken threw in beforeModel");
    expect((result as { message: string }).message).toContain("no clock here");
  });

  it("is refused when two hooks share an id", async () => {
    const a = defineHook({ id: "same" });
    await expect(run([final("never")], { hooks: [a, a] })).rejects.toThrow(SpecError);
    await expect(run([final("never")], { hooks: [a, a] })).rejects.toThrow(
      "two hooks are called same",
    );
  });

  it("runs after the harness's own", async () => {
    const order: string[] = [];
    const first = defineHook({
      id: "first",
      beforeModel: () => {
        order.push("first");
        return undefined;
      },
    });
    const second = defineHook({
      id: "second",
      beforeModel: () => {
        order.push("second");
        return undefined;
      },
    });
    await run([final("done")], { hooks: [first, second] });
    expect(order).toEqual(["first", "second"]);
  });
});

describe("the harness's hooks", () => {
  const checkpoint = (): RunCheckpoint => ({
    version: 1,
    agentId: "hooked",
    agentVersion: 1,
    step: 0,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      budgetCostUsd: 0,
      steps: 0,
    },
    messages: 0,
    lastSeq: 0,
    invalidOutputs: 0,
    blockedFinishes: 0,
    wrote: false,
    pendingChanges: {},
  });
  const agent: AgentDefinition = { spec: spec(), output: Output };
  const toolCall = { id: "c1", name: "ping", arguments: "{}" };

  /** The same events fed to the hooks of a run, twice, from the same saved state. */
  function replay(state: RunCheckpoint) {
    const hooks = createHooks(harnessHooks(agent), state);
    const messages = [{ role: "user" as const, content: "go" }];
    return [
      hooks.beforeModel({ step: 5, maxSteps: 6, hasOutput: true }, messages),
      hooks.afterModel({
        step: 5,
        hasOutput: true,
        finishReason: "end_turn",
        cutOff: false,
        toolCalls: 0,
        pendingChanges: {},
      }),
      hooks.afterTool({ stage: "denied", reason: "no", step: 5, call: toolCall, args: "{}" }),
      hooks.afterTool({ stage: "denied", reason: "no", step: 5, call: toolCall, args: "{}" }),
      hooks.beforeFinal({ value: { summary: "x" }, ctx: { runId: "r", tenantId: "t" }, messages }),
      state.hooks,
    ];
  }

  it("give the same answers twice from the same saved state", () => {
    const start = checkpoint();
    start.hooks = { stepsLeft: { warned: false } };
    expect(replay(structuredClone(start))).toEqual(replay(structuredClone(start)));
  });

  it("warn once, two turns before the limit", () => {
    const state = checkpoint();
    const hooks = createHooks(harnessHooks(agent), state);
    const at = (step: number) => hooks.beforeModel({ step, maxSteps: 6, hasOutput: true }, []);
    expect(at(4).append).toEqual([]);
    expect(at(5).append).toEqual([
      { role: "user", content: "2 model turns left. Finish now.\nCall final with your result." },
    ]);
    expect(at(5).append).toEqual([]);
    expect(state.hooks).toEqual({ stepsLeft: { warned: true } });
  });

  it("stop on the same refused call sent again, and on a third failure", () => {
    const state = checkpoint();
    const hooks = createHooks(harnessHooks(agent), state);
    const event = { step: 1, call: toolCall, args: "{}" };
    expect(hooks.afterTool({ stage: "denied", reason: "x", ...event })).toBeUndefined();
    expect(hooks.afterTool({ stage: "denied", reason: "x", ...event })).toBe(
      "ping was refused, and the same call was sent again unchanged",
    );
    // a call that passes the checks starts the count again
    const fresh = checkpoint();
    const again = createHooks(harnessHooks(agent), fresh);
    again.afterTool({ stage: "denied", reason: "x", ...event });
    again.afterTool({ stage: "cleared", ...event });
    expect(again.afterTool({ stage: "denied", reason: "x", ...event })).toBeUndefined();

    const failing = createHooks(harnessHooks(agent), checkpoint());
    const ran = { stage: "ran" as const, ok: false, ...event };
    expect(failing.afterTool(ran)).toBeUndefined();
    expect(failing.afterTool(ran)).toBeUndefined();
    expect(failing.afterTool(ran)).toBe("ping failed 3 times with the same input");
  });

  it("do not stop a gate that says not yet, however often it is asked again", () => {
    const hooks = createHooks(harnessHooks(agent), checkpoint());
    const event = { step: 1, call: toolCall, args: "{}" };
    for (let i = 0; i < 5; i++) {
      expect(
        hooks.afterTool({ stage: "denied", reason: "not yet", advisory: true, ...event }),
      ).toBeUndefined();
    }
    // and an ordinary refusal after them still starts its own count
    expect(hooks.afterTool({ stage: "denied", reason: "x", ...event })).toBeUndefined();
    expect(hooks.afterTool({ stage: "denied", reason: "x", ...event })).toBe(
      "ping was refused, and the same call was sent again unchanged",
    );
  });

  it("carry a run saved before hooks over to the new state", () => {
    const old = checkpoint();
    old.stepsWarned = true;
    old.refused = { tool: "ping", args: "{}" };
    old.failedCall = { tool: "ping", args: "{}", count: 2 };
    carryOverLegacyState(old);

    expect(old.hooks).toEqual({
      stepsLeft: { warned: true },
      repeatedCalls: {
        refused: { tool: "ping", args: "{}" },
        failed: { tool: "ping", args: "{}", count: 2 },
      },
    });
    expect(old.stepsWarned).toBeUndefined();
    expect(old.refused).toBeUndefined();
    expect(old.failedCall).toBeUndefined();

    // and a run that was warned does not get the warning twice
    const hooks = createHooks(harnessHooks(agent), old);
    expect(hooks.beforeModel({ step: 5, maxSteps: 6, hasOutput: true }, []).append).toEqual([]);
  });

  it("leave a new run's checkpoint without hook state until a hook has some", () => {
    const state = checkpoint();
    carryOverLegacyState(state);
    expect(state.hooks).toBeUndefined();
  });
});
