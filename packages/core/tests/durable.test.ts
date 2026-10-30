import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSpec,
  type ApprovalDecision,
  type ApprovalRequest,
  defineTool,
  type Message,
  type RunCheckpoint,
  type RunEvent,
  type RunStore,
} from "@dugout/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Approver,
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
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
  model: { tier: "smart" },
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
  approver: Approver;
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
    approver: opts.approver,
    runsDir,
    sinks: [sink],
    outputs: createMemoryOutputStore(),
    store: opts.store,
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  return { result, events: sink.events, model };
}

const later: Approver = async () => ({ pending: true });
const approve: Approver = async () => ({ approved: true, by: "editor" });
const decided = (decision: ApprovalDecision) => ({ reason: "approval" as const, decision });
const transcript = (store: ReturnType<typeof createMemoryRunStore>, runId: string) =>
  store.runs.get(`demo-cricket/${runId}`)?.messages ?? [];
const seqs = (events: RunEvent[]) => events.map((e) => e.seq);

describe("working memory saved between invocations", () => {
  it("stops at an approval and resumes to the same end as a run that waited in place", async () => {
    // the reference: one invocation, the approver answers at once
    const inPlace = createMemoryRunStore();
    await invoke({
      runId: "in-place",
      store: inPlace,
      script: [call("draft.save", { text: "a" }), final("saved")],
      approver: approve,
    });
    written.length = 0;

    const store = createMemoryRunStore();
    const first = await invoke({
      runId: "r1",
      store,
      script: [call("draft.save", { text: "a" })],
      approver: later,
    });
    expect(first.result).toMatchObject({
      status: "waiting",
      approval: { tool: "draft.save", input: { text: "a" } },
    });
    expect(written).toEqual([]);
    const waiting = store.runs.get("demo-cricket/r1")?.checkpoint as RunCheckpoint;
    expect(waiting.waiting?.callId).toBe(
      first.result.status === "waiting" && first.result.approval.callId,
    );
    expect(waiting.lastSeq).toBe(first.events.at(-1)?.seq);

    // a new invocation, as after a restart: only the store carries the run over
    const second = await invoke({
      runId: "r1",
      store,
      script: [final("saved")],
      approver: approve,
      resume: decided({ approved: true, by: "editor" }),
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
      data: { agentId: "durable-agent", step: 1, reason: "approval" },
    });
    expect(second.events.map((e) => e.type)).toContain("approval.granted");
    // the model was not asked again for the turn it had already taken
    expect(second.model.requests).toHaveLength(1);
  });

  it("resumes with a change request in the same transcript", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "r2",
      store,
      script: [call("draft.save", { text: "a" })],
      approver: later,
    });
    const second = await invoke({
      runId: "r2",
      store,
      script: [call("draft.save", { text: "b" })],
      approver: later,
      resume: decided({ approved: false, by: "editor", changes: "Use b." }),
    });
    expect(second.result).toMatchObject({ status: "waiting", approval: { input: { text: "b" } } });
    const sentBack = second.model.requests[0]?.messages ?? [];
    expect(sentBack.at(-1)).toMatchObject({ role: "user" });
    expect(sentBack.at(-1)?.content).toContain('"Use b."');
    expect(JSON.stringify(sentBack)).toContain('\\"text\\":\\"a\\"');

    // the run cannot finish while the change waits for approval, even across invocations
    const third = await invoke({
      runId: "r2",
      store,
      script: [final("saved")],
      approver: approve,
      resume: decided({ approved: true, by: "editor" }),
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
      approver: later,
    });
    const second = await invoke({
      runId: "r3",
      store,
      script: [],
      approver: approve,
      resume: decided({ approved: false, by: "editor", reason: "no" }),
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
      approver: later,
      runsDir,
      outputs: createMemoryOutputStore(),
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "error",
      message: "an approver can only answer later when the run has a store to resume from",
    });
  });

  it("refuses to resume a run saved by another version of the agent", async () => {
    const store = createMemoryRunStore();
    await invoke({
      runId: "r4",
      store,
      script: [call("draft.save", { text: "a" })],
      approver: later,
    });
    await expect(
      invoke({
        runId: "r4",
        store,
        script: [final("x")],
        approver: approve,
        resume: decided({ approved: true, by: "editor" }),
        version: 2,
      }),
    ).rejects.toThrow("durable-agent v2 cannot resume a run saved by durable-agent v1");
  });
});

/** A store that dies (like a crashed process) on one save, after storing everything before it. */
function crashingStore(crashWhen: (checkpoint: RunCheckpoint, appended: Message[]) => boolean) {
  const inner = createMemoryRunStore();
  let crashed = false;
  const store: RunStore = {
    load: (ctx) => inner.load(ctx),
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

  it("does not ask the reviewer again for a call approved before the crash", async () => {
    const asked: ApprovalRequest[] = [];
    const approver: Approver = async (req) => {
      asked.push(req);
      return { approved: true, by: "editor" };
    };
    // dies when about to run the approved tool
    const { store } = crashingStore((cp) => (cp.turn?.started.length ?? 0) > 0);
    const first = invoke({
      runId: "c1",
      store,
      script: [call("draft.save", { text: "a" })],
      approver,
    });
    await expect(first).rejects.toThrow(RunInterrupted);
    expect(written).toEqual([]);

    const second = await invoke({
      runId: "c1",
      store,
      script: [final("saved")],
      approver,
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
        approver: approve,
      }),
    ).rejects.toThrow(RunInterrupted);
    expect(written).toEqual(["draft:a"]);

    const second = await invoke({
      runId: "c2",
      store,
      script: [final("saved")],
      approver: approve,
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
        approver: approve,
      }),
    ).rejects.toThrow(RunInterrupted);
    expect(written).toEqual(["email:fan@x"]);

    const second = await invoke({
      runId: "c3",
      store,
      script: [final("checked")],
      approver: approve,
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
        approver: approve,
      }),
    ).rejects.toThrow(RunInterrupted);

    const second = await invoke({
      runId: "c4",
      store,
      script: [call("draft.save", { text: "a" }), final("saved")],
      approver: approve,
      resume: recover(100),
    });
    expect(second.result).toMatchObject({ status: "completed", usage: { steps: 2 } });
    expect(written).toEqual(["draft:a"]);
  });
});
