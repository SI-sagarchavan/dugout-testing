import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSpec,
  approve,
  type Decision,
  defineTool,
  type InterruptRequest,
  type Message,
  type RunCheckpoint,
  type RunEvent,
  type RunStore,
  reject,
  requestChange,
} from "@dugout/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  correctedInput,
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  forkRun,
  type Responder,
  RunInterrupted,
  runLocal,
  type ScriptStep,
  scriptedModelConfig,
} from "../src/index.ts";

let written: string[];
/** A write that is safe to run twice (`retries`), and one that is not. */
const draftSave = defineTool({
  name: "draft.save",
  description: "Save a draft",
  input: z.object({ text: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  retries: 1,
  async run({ text }) {
    written.push(`draft:${text}`);
    return { saved: true };
  },
});
const emailSend = defineTool({
  name: "email.send",
  description: "Send an email",
  input: z.object({ to: z.string() }),
  effect: "write",
  timeoutMs: 1_000,
  async run({ to }) {
    written.push(`email:${to}`);
    return { sent: true };
  },
});

const spec = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "durable-agent",
  version: 1,
  owner: "tests",
  instructions: "You are a test agent.",
  tools: ["draft.save", "email.send"],
  skills: [],
  onDemandSkills: [],
  model: "nova-lite",
  memory: { read: [], write: [] },
  budget: { usdPerRun: 1, maxSteps: 8, maxDepth: 0 },
  approvals: [],
  ...overrides,
});
const Output = z.object({ summary: z.string() });
const call = (name: string, args: unknown = {}) => ({ toolCalls: [{ name, arguments: args }] });
const final = (summary: string) => call("final", { summary });

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "dugout-durable-"));
  written = [];
});

/** One invocation of a run; `script` is what the model says in this invocation. */
async function invoke(opts: {
  runId: string;
  store: RunStore;
  script: ScriptStep[];
  responder: Responder;
  resume?: Parameters<typeof runLocal>[0]["resume"];
  version?: number;
}) {
  const sink = createMemorySink();
  const model = createScriptedModel(opts.script);
  const result = await runLocal({
    agent: { spec: spec({ version: opts.version ?? 1 }), output: Output },
    input: "Write and save a draft",
    tenantId: "demo-cricket",
    runId: opts.runId,
    tools: [draftSave, emailSend],
    client: model,
    models: scriptedModelConfig(),
    responder: opts.responder,
    runsDir,
    sinks: [sink],
    outputs: createMemoryOutputStore(),
    store: opts.store,
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  return { result, events: sink.events, model };
}

const later: Responder = async () => ({ pending: true });
const approves: Responder = async () => approve("editor");
const decided = (decision: Decision) => ({ reason: "answered" as const, decision });
const transcript = (store: ReturnType<typeof createMemoryRunStore>, runId: string) =>
  store.runs.get(`demo-cricket/${runId}`)?.messages ?? [];
const seqs = (events: RunEvent[]) => events.map((e) => e.seq);

describe("working memory saved between invocations", () => {
  it("stops at an approval and resumes to the same end as a run that waited in place", async () => {
    // the reference: one invocation, the responder answers at once
    const inPlace = createMemoryRunStore();
    await invoke({
      runId: "in-place",
      store: inPlace,
      script: [call("draft.save", { text: "a" }), final("saved")],
      responder: approves,
    });
    written.length = 0;

    const store = createMemoryRunStore();
    const first = await invoke({
      runId: "r1",
      store,
      script: [call("draft.save", { text: "a" })],
      responder: later,
    });
    expect(first.result).toMatchObject({
      status: "waiting",
      waiting: { tool: "draft.save", input: { text: "a" } },
    });
    expect(written).toEqual([]);
    const waiting = store.runs.get("demo-cricket/r1")?.points.at(-1)?.checkpoint as RunCheckpoint;
    expect(waiting.waiting?.callId).toBe(
      first.result.status === "waiting" && first.result.waiting.callId,
    );
    expect(waiting.lastSeq).toBe(first.events.at(-1)?.seq);

    // a new invocation, as after a restart: only the store carries the run over
    const second = await invoke({
      runId: "r1",
      store,
      script: [final("saved")],
      responder: approves,
      resume: decided(approve("editor")),
    });
    expect(second.result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(written).toEqual(["draft:a"]);
    // the scripted model numbers call ids per instance, and the resumed invocation has a new one
    const ids = (ms: Message[]) => JSON.parse(JSON.stringify(ms).replace(/call_\d+_\d+/g, "call"));
    expect(ids(transcript(store, "r1"))).toEqual(ids(transcript(inPlace, "in-place")));

    const all = [...first.events, ...second.events];
    expect(seqs(all)).toEqual(all.map((_, i) => i + 1));
    expect(second.events[0]).toMatchObject({
      type: "run.resumed",
      data: { agentId: "durable-agent", step: 1, reason: "answered" },
    });
    expect(second.events.map((e) => e.type)).toContain("question.answered");
    // the model was not asked again for the turn it had already taken
    expect(second.model.requests).toHaveLength(1);
  });

  it("resumes with a change request in the same transcript", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "r2",
      store,
      script: [call("draft.save", { text: "a" })],
      responder: later,
    });
    const second = await invoke({
      runId: "r2",
      store,
      script: [call("draft.save", { text: "b" })],
      responder: later,
      resume: decided(requestChange("editor", "Use b.")),
    });
    expect(second.result).toMatchObject({ status: "waiting", waiting: { input: { text: "b" } } });
    const sentBack = second.model.requests[0]?.messages ?? [];
    expect(sentBack.at(-1)).toMatchObject({ role: "user" });
    expect(sentBack.at(-1)?.content).toContain('"Use b."');
    expect(JSON.stringify(sentBack)).toContain('\\"text\\":\\"a\\"');

    // the run cannot finish while the change waits for approval, even across invocations
    const third = await invoke({
      runId: "r2",
      store,
      script: [final("saved")],
      responder: approves,
      resume: decided(approve("editor")),
    });
    expect(third.result).toMatchObject({ status: "completed" });
    expect(written).toEqual(["draft:b"]);
  });

  it("ends as rejected when the decision is a rejection", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "r3",
      store,
      script: [call("draft.save", { text: "a" })],
      responder: later,
    });
    const second = await invoke({
      runId: "r3",
      store,
      script: [],
      responder: approves,
      resume: decided(reject("editor", "no")),
    });
    expect(second.result).toMatchObject({ status: "rejected", output: { reason: "no" } });
    expect(written).toEqual([]);
  });

  it("refuses to wait for a decision when nothing can keep the run", async () => {
    const result = await runLocal({
      agent: { spec: spec(), output: Output },
      input: "x",
      tenantId: "demo-cricket",
      tools: [draftSave, emailSend],
      client: createScriptedModel([call("draft.save", { text: "a" })]),
      models: scriptedModelConfig(),
      responder: later,
      runsDir,
      outputs: createMemoryOutputStore(),
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "error",
      message: "a responder can only answer later when the run has a store to resume from",
    });
  });

  it("refuses to resume a run saved by another version of the agent", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "r4",
      store,
      script: [call("draft.save", { text: "a" })],
      responder: later,
    });
    await expect(
      invoke({
        runId: "r4",
        store,
        script: [final("x")],
        responder: approves,
        resume: decided(approve("editor")),
        version: 2,
      }),
    ).rejects.toThrow("durable-agent v2 cannot resume a run saved by durable-agent v1");
  });
});

describe("save points and forks", () => {
  const ctx = (runId: string) => ({ tenantId: "demo-cricket", runId });
  /** Saves a fork of `runId` at `version` as run `forkId`, ready to be resumed. */
  const fork = async (
    store: RunStore,
    runId: string,
    version: number,
    forkId: string,
    change: Parameters<typeof forkRun>[2] = {},
  ) => {
    const saved = await store.load(ctx(runId), version);
    if (!saved) throw new Error(`no save point ${version}`);
    const forked = forkRun(saved, { runId, version }, change);
    await store.save(ctx(forkId), forked.checkpoint, forked.messages);
    return forked;
  };

  it("lists every save point with its step and what it came after", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "r1",
      store,
      script: [call("draft.save", { text: "a" }), final("saved")],
      responder: approves,
    });
    const history = await store.history(ctx("r1"));
    expect(history.map((p) => [p.version, p.step, p.savedAfter])).toEqual([
      [1, 0, "start"],
      [2, 1, "model"],
      // asked for the approval, even though the responder answers at once
      [3, 1, "waiting"],
      [4, 1, "decision"],
      [5, 1, "call"],
      [6, 1, "tool"],
      // the turn answered
      [7, 1, "tool"],
      [8, 2, "model"],
      [9, 2, "end"],
    ]);
    expect(history[2]?.waiting).toMatchObject({ tool: "draft.save" });
    // each save point's transcript is the start of the run's
    const second = await store.load(ctx("r1"), 2);
    expect(second?.messages).toEqual(transcript(store, "r1").slice(0, 3));
  });

  it("forks a run at its approval with the other decision; both complete, neither changes the other", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "parent",
      store,
      script: [call("draft.save", { text: "a" })],
      responder: later,
    });
    const history = await store.history(ctx("parent"));
    const waiting = history.findLast((p) => p.waiting) as (typeof history)[number];
    const before = structuredClone(store.runs.get("demo-cricket/parent"));

    await fork(store, "parent", waiting.version, "fork", {
      decision: reject("editor", "not this one"),
    });
    const forked = await invoke({
      runId: "fork",
      store,
      script: [],
      responder: later,
      resume: {
        reason: "answered",
        decision: reject("editor", "not this one"),
      },
    });
    expect(forked.result).toMatchObject({ status: "rejected", output: { reason: "not this one" } });
    expect(forked.events[0]).toMatchObject({
      type: "run.resumed",
      data: { reason: "fork", forkedFrom: { runId: "parent", version: waiting.version } },
    });
    // the fork wrote nothing to its parent
    expect(store.runs.get("demo-cricket/parent")).toEqual(before);
    expect(written).toEqual([]);

    const parent = await invoke({
      runId: "parent",
      store,
      script: [final("saved")],
      responder: later,
      resume: decided(approve("editor")),
    });
    expect(parent.result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    expect(written).toEqual(["draft:a"]);
    // and the parent's end changed nothing of the fork's
    expect((await store.load(ctx("fork")))?.checkpoint.savedAfter).toBe("decision");
  });

  it("sends the model, from a fork, the same request its parent sent at that point", async () => {
    const store = createMemoryRunStore();
    const parent = await invoke({
      runId: "parent",
      store,
      script: [call("draft.save", { text: "a" }), final("saved")],
      responder: approves,
    });
    // the save point before the second model turn: the first turn answered in full
    const history = await store.history(ctx("parent"));
    const before = history.findLast((p) => p.step === 1) as (typeof history)[number];
    await fork(store, "parent", before.version, "fork");

    const forked = await invoke({
      runId: "fork",
      store,
      script: [final("saved again")],
      responder: approves,
      resume: { reason: "recovery" },
    });
    expect(forked.result).toMatchObject({
      status: "completed",
      output: { summary: "saved again" },
    });
    expect(forked.model.requests[0]).toEqual(parent.model.requests[1]);
    // the fork counts only what it spent
    expect(forked.result.usage.steps).toBe(1);
  });

  it("brings a fork its corrected input after the transcript, never inside a turn", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "parent",
      store,
      script: [call("draft.save", { text: "a" })],
      responder: later,
    });
    const forked = await fork(store, "parent", 1, "fork", { input: { brief: "two drafts" } });
    expect(forked.messages.at(-1)).toEqual({
      role: "user",
      content: correctedInput({ brief: "two drafts" }),
    });
    expect(forked.messages.slice(0, -1)).toEqual(transcript(store, "parent").slice(0, 2));

    const history = await store.history(ctx("parent"));
    const midTurn = history.findLast((p) => p.waiting) as (typeof history)[number];
    await expect(fork(store, "parent", midTurn.version, "f2", { input: "x" })).rejects.toThrow(
      "in the middle of a turn",
    );
    await expect(fork(store, "parent", 1, "f3", { decision: approve("editor") })).rejects.toThrow(
      "waits for no one",
    );
  });
});

/** A store that dies (like a crashed process) on one save, after storing everything before it. */
function crashingStore(crashWhen: (checkpoint: RunCheckpoint, appended: Message[]) => boolean) {
  const inner = createMemoryRunStore();
  let crashed = false;
  const store: RunStore = {
    load: (ctx, version) => inner.load(ctx, version),
    history: (ctx) => inner.history(ctx),
    async save(ctx, checkpoint, appended) {
      if (!crashed && crashWhen(checkpoint, appended)) {
        crashed = true;
        throw new RunInterrupted("process died");
      }
      await inner.save(ctx, checkpoint, appended);
    },
  };
  return { store, inner };
}

describe("picking a run up after a crash", () => {
  const recover = (startSeq: number) => ({ reason: "recovery" as const, startSeq });

  it("still stops on a refused call sent again after the crash", async () => {
    const store = createMemoryRunStore();
    const refusedCall = call("draft.save", { text: 3 });
    await expect(
      invoke({
        runId: "c5",
        store,
        script: [
          refusedCall,
          () => {
            throw new RunInterrupted("process died");
          },
        ],
        responder: approves,
      }),
    ).rejects.toThrow(RunInterrupted);

    const second = await invoke({
      runId: "c5",
      store,
      script: [refusedCall],
      responder: approves,
      resume: recover(100),
    });
    expect(second.result).toMatchObject({
      status: "failed",
      reason: "invalid_output",
      message: "draft.save was refused, and the same call was sent again unchanged",
    });
  });

  it("keeps counting identical failures across the crash", async () => {
    const store = createMemoryRunStore();
    const failing = defineTool({
      name: "draft.save",
      description: "Save a draft",
      input: z.object({ text: z.string() }),
      effect: "write",
      timeoutMs: 1_000,
      async run() {
        throw new Error("nope");
      },
    });
    const go = (script: ScriptStep[], resume?: ReturnType<typeof recover>) =>
      runLocal({
        agent: { spec: spec({ tools: ["draft.save"] }), output: Output },
        input: "Write and save a draft",
        tenantId: "demo-cricket",
        runId: "c6",
        tools: [failing],
        client: createScriptedModel(script),
        models: scriptedModelConfig(),
        responder: approves,
        runsDir,
        outputs: createMemoryOutputStore(),
        store,
        ...(resume ? { resume } : {}),
      });
    const save = call("draft.save", { text: "a" });
    await expect(
      go([
        save,
        save,
        () => {
          throw new RunInterrupted("process died");
        },
      ]),
    ).rejects.toThrow(RunInterrupted);
    const result = await go([save], recover(100));
    expect(result).toMatchObject({
      status: "failed",
      message: "draft.save failed 3 times with the same input",
    });
  });

  it("does not ask the reviewer again for a call approved before the crash", async () => {
    const asked: InterruptRequest[] = [];
    const responder: Responder = async (req) => {
      asked.push(req);
      return approve("editor");
    };
    // dies when about to run the approved tool
    const { store } = crashingStore((cp) => (cp.turn?.started.length ?? 0) > 0);
    const first = invoke({
      runId: "c1",
      store,
      script: [call("draft.save", { text: "a" })],
      responder,
    });
    await expect(first).rejects.toThrow(RunInterrupted);
    expect(written).toEqual([]);

    const second = await invoke({
      runId: "c1",
      store,
      script: [final("saved")],
      responder,
      resume: recover(100),
    });
    expect(second.result).toMatchObject({ status: "completed" });
    expect(asked).toHaveLength(1);
    expect(written).toEqual(["draft:a"]);
    expect(second.events[0]).toMatchObject({
      type: "run.resumed",
      seq: 101,
      data: { reason: "recovery" },
    });
  });

  it("runs a retry-safe write again when it may not have finished", async () => {
    // dies right after the tool ran, before its result was saved
    const { store } = crashingStore((_, appended) => appended.some((m) => m.role === "tool"));
    await expect(
      invoke({
        runId: "c2",
        store,
        script: [call("draft.save", { text: "a" })],
        responder: approves,
      }),
    ).rejects.toThrow(RunInterrupted);
    expect(written).toEqual(["draft:a"]);

    const second = await invoke({
      runId: "c2",
      store,
      script: [final("saved")],
      responder: approves,
      resume: recover(100),
    });
    expect(second.result).toMatchObject({ status: "completed" });
    expect(written).toEqual(["draft:a", "draft:a"]);
  });

  it("tells the model the outcome is unknown instead of repeating an unsafe write", async () => {
    const { store } = crashingStore((_, appended) => appended.some((m) => m.role === "tool"));
    await expect(
      invoke({
        runId: "c3",
        store,
        script: [call("email.send", { to: "fan@x" })],
        responder: approves,
      }),
    ).rejects.toThrow(RunInterrupted);
    expect(written).toEqual(["email:fan@x"]);

    const second = await invoke({
      runId: "c3",
      store,
      script: [final("checked")],
      responder: approves,
      resume: recover(100),
    });
    expect(second.result).toMatchObject({ status: "completed" });
    expect(written).toEqual(["email:fan@x"]);
    expect(second.model.requests[0]?.messages.at(-1)?.content).toContain(
      "the run stopped while this call was running, so it may or may not have taken effect",
    );
  });

  it("calls the model again when the crash came before its turn was saved", async () => {
    // dies on the save that would record the model's first turn
    const { store } = crashingStore((cp) => cp.step === 1);
    await expect(
      invoke({
        runId: "c4",
        store,
        script: [call("draft.save", { text: "a" })],
        responder: approves,
      }),
    ).rejects.toThrow(RunInterrupted);

    const second = await invoke({
      runId: "c4",
      store,
      script: [call("draft.save", { text: "a" }), final("saved")],
      responder: approves,
      resume: recover(100),
    });
    expect(second.result).toMatchObject({ status: "completed", usage: { steps: 2 } });
    expect(written).toEqual(["draft:a"]);
  });
});
