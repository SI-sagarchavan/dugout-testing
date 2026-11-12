import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDefinition,
  type AgentSpec,
  approve,
  defineState,
  defineTool,
  MAX_STATE_VALUE_CHARS,
  type RunEvent,
  type RunStore,
} from "@dugout/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  type Responder,
  runLocal,
  type ScriptStep,
  scriptedModelConfig,
} from "../src/index.ts";

/** What `draft.save` keeps for the calls after it and for the checks on `final`. */
const SAVED = defineState<{ id: string; text: string }>("draft.saved");
const NOTE = defineState<string>("draft.note");

let attempts: number;
const draftSave = defineTool({
  name: "draft.save",
  description: "Save a draft",
  input: z.object({ text: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  async run({ text }, ctx) {
    ctx.state.set(SAVED, { id: `draft-${text.length}`, text });
    return { saved: true };
  },
});
const draftRead = defineTool({
  name: "draft.read",
  description: "What was saved",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  run: async (_input, ctx) => ctx.state.get(SAVED) ?? { saved: false },
});
const draftFail = defineTool({
  name: "draft.fail",
  description: "Keeps something, then fails",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  async run(_input, ctx) {
    ctx.state.set(NOTE, "kept by a call that failed");
    throw new Error("disk full");
  },
});
const draftRetry = defineTool({
  name: "draft.retry",
  description: "Fails once, then succeeds",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  retries: 1,
  async run(_input, ctx) {
    attempts++;
    const before = ctx.state.get(NOTE);
    ctx.state.set(NOTE, `attempt ${attempts}, found ${before ?? "nothing"}`);
    if (attempts === 1) throw new Error("try again");
    return { ok: true };
  },
});
const draftClear = defineTool({
  name: "draft.clear",
  description: "Forgets the draft",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  async run(_input, ctx) {
    ctx.state.set(SAVED, undefined);
    return { cleared: true };
  },
});
const draftBig = defineTool({
  name: "draft.big",
  description: "Keeps too much",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  async run(_input, ctx) {
    ctx.state.set(NOTE, "x".repeat(MAX_STATE_VALUE_CHARS + 1));
    return { ok: true };
  },
});
const draftContact = defineTool({
  name: "draft.contact",
  description: "Keeps a contact",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  async run(_input, ctx) {
    ctx.state.set(NOTE, "write to press@example.com");
    return { ok: true };
  },
});
const emailSend = defineTool({
  name: "email.send",
  description: "Send an email",
  input: z.object({ to: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  run: async () => ({ sent: true }),
});

const tools = [
  draftSave,
  draftRead,
  draftFail,
  draftRetry,
  draftClear,
  draftBig,
  draftContact,
  emailSend,
];
const spec = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "state-agent",
  version: 1,
  owner: "tests",
  instructions: "You are a test agent.",
  tools: tools.map((t) => t.name),
  skills: [],
  onDemandSkills: [],
  model: "nova-lite",
  memory: { read: [], write: [] },
  budget: { usdPerRun: 1, maxSteps: 8, maxDepth: 0 },
  approvals: [],
  ...overrides,
});
const Output = z.object({ summary: z.string(), id: z.string().optional() });
const call = (name: string, args: unknown = {}) => ({ toolCalls: [{ name, arguments: args }] });
const final = (summary: string) => call("final", { summary });

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "dugout-state-"));
  attempts = 0;
});

async function run(
  script: ScriptStep[],
  opts: {
    agent?: Partial<AgentDefinition>;
    store?: RunStore;
    runId?: string;
    responder?: Responder;
    resume?: Parameters<typeof runLocal>[0]["resume"];
  } = {},
) {
  const sink = createMemorySink();
  const result = await runLocal({
    agent: { spec: spec(), output: Output, ...opts.agent },
    input: "Write and save a draft",
    tenantId: "demo-cricket",
    tools,
    client: createScriptedModel(script),
    models: scriptedModelConfig(),
    responder: opts.responder ?? (async () => approve("editor")),
    runsDir,
    sinks: [sink],
    outputs: createMemoryOutputStore(),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  return { result, events: sink.events };
}

const completed = (events: RunEvent[], tool: string) =>
  events.flatMap((e) => (e.type === "tool.completed" && e.data.tool === tool ? [e.data] : []));

describe("a run's state", () => {
  it("gives a later call what an earlier call kept, and says so on the call's event", async () => {
    const { result, events } = await run([
      call("draft.save", { text: "hello" }),
      call("draft.read"),
      final("done"),
    ]);

    expect(result.status).toBe("completed");
    expect(completed(events, "draft.read")[0]?.content).toBe(
      JSON.stringify({ id: "draft-5", text: "hello" }),
    );
    expect(completed(events, "draft.save")[0]?.state).toEqual({
      "draft.saved": { id: "draft-5", text: "hello" },
    });
    // a call that kept nothing says nothing
    expect(completed(events, "draft.read")[0]?.state).toBeUndefined();
  });

  it("is what the checks on final read: completeFinal fills from it, verifyFinal refuses without it", async () => {
    const agent: Partial<AgentDefinition> = {
      completeFinal: (output, { state }) => ({
        ...(output as object),
        ...(state.get(SAVED) ? { id: state.get(SAVED)?.id } : {}),
      }),
      verifyFinal: (_output, { state }) =>
        state.get(SAVED) ? undefined : "Nothing was saved. Call draft.save before final.",
    };
    const { result, events } = await run(
      [final("too early"), call("draft.save", { text: "hello" }), final("done")],
      { agent },
    );

    expect(result).toMatchObject({
      status: "completed",
      output: { summary: "done", id: "draft-5" },
    });
    expect(events.filter((e) => e.type === "final.refused").map((e) => e.data.reason)).toEqual([
      "Nothing was saved. Call draft.save before final.",
    ]);
  });

  it("drops what a call that failed set", async () => {
    const { events } = await run([call("draft.fail"), call("draft.read"), final("done")], {
      agent: {
        verifyFinal: (_o, { state }) => (state.get(NOTE) ? `kept: ${state.get(NOTE)}` : undefined),
      },
    });

    expect(completed(events, "draft.fail")[0]).toMatchObject({ ok: false });
    expect(completed(events, "draft.fail")[0]?.state).toBeUndefined();
    expect(events.some((e) => e.type === "final.refused")).toBe(false);
  });

  it("starts each attempt of a call from what the call found, and keeps the one that succeeded", async () => {
    const { events } = await run([call("draft.retry"), final("done")]);

    expect(attempts).toBe(2);
    expect(completed(events, "draft.retry")[0]?.state).toEqual({
      "draft.note": "attempt 2, found nothing",
    });
  });

  it("removes a key set to undefined", async () => {
    const store = createMemoryRunStore();
    const { events } = await run(
      [call("draft.save", { text: "hello" }), call("draft.clear"), call("draft.read"), final("x")],
      { store, runId: "cleared" },
    );

    expect(completed(events, "draft.read")[0]?.content).toBe(JSON.stringify({ saved: false }));
    expect(store.runs.get("demo-cricket/cleared")?.points.at(-1)?.checkpoint.state).toBeUndefined();
  });

  it("refuses a value too large to save with every save point", async () => {
    const { events } = await run([call("draft.big"), final("done")]);

    expect(completed(events, "draft.big")[0]).toMatchObject({ ok: false });
    expect(completed(events, "draft.big")[0]?.content).toMatch(
      /state draft\.note is \d+ characters; one value holds at most 32000/,
    );
  });

  it("is redacted like a tool result, since it is saved with the run", async () => {
    const { events } = await run([call("draft.contact"), final("done")]);

    expect(completed(events, "draft.contact")[0]?.state).toEqual({
      "draft.note": "write to [REDACTED:email]",
    });
  });

  it("is saved with the run, so a run resumed after a pause reads what was kept before it", async () => {
    const store = createMemoryRunStore();
    const agent: Partial<AgentDefinition> = {
      completeFinal: (output, { state }) => ({
        ...(output as object),
        id: state.get(SAVED)?.id,
      }),
    };
    const first = await run(
      [call("draft.save", { text: "hello" }), call("email.send", { to: "desk" })],
      {
        agent,
        store,
        runId: "paused",
        // the draft is saved at once; the email waits for a person
        responder: async (req) =>
          req.tool === "email.send" ? { pending: true } : approve("editor"),
      },
    );
    expect(first.result.status).toBe("waiting");
    expect(store.runs.get("demo-cricket/paused")?.points.at(-1)?.checkpoint.state).toEqual({
      "draft.saved": { id: "draft-5", text: "hello" },
    });

    const second = await run([call("draft.read"), final("done")], {
      agent,
      store,
      runId: "paused",
      resume: { reason: "answered", decision: approve("editor") },
    });

    expect(completed(second.events, "draft.read")[0]?.content).toBe(
      JSON.stringify({ id: "draft-5", text: "hello" }),
    );
    expect(second.result).toMatchObject({
      status: "completed",
      output: { summary: "done", id: "draft-5" },
    });
  });
});
