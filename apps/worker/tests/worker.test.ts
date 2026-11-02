import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, RunCheckpoint, RunEvent } from "@dugout/contracts";
import {
  correctedInput,
  createScriptedModel,
  RunInterrupted,
  scriptedModelConfig,
  TransientModelError,
} from "@dugout/core";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { seedHouseFacts } from "@dugout/sdk";
import { drafter } from "@dugout/sdk/testing";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type AgentEntry,
  createPostgresRunStore,
  createRunQueue,
  createValkeyEventLog,
  createWorker,
} from "../src/index.ts";
import { writer } from "./writer.ts";

const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const memory = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
const queue = createRunQueue({ pool, events });
const TENANT = "demo-cricket";
const INPUT = { topicId: "t-101" };
let runsDir: string;
const errors: unknown[] = [];

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "runs-worker-"));
  await seedHouseFacts(memory, [TENANT]);
});
afterAll(async () => {
  await pool.end();
  valkey.disconnect();
});

const entry = (client: () => ModelClient): AgentEntry => ({
  input: drafter.input,
  run: (opts) =>
    drafter.create({
      store: memory,
      client: client(),
      models: scriptedModelConfig(),
      runsDir,
      draftsDir: join(runsDir, "drafts"),
      consolidate: false,
      // a transient model error is retried at once, so the tests don't wait
      retryDelayMs: () => 0,
    })(opts),
});
/** One worker process. Two of them with the same database are a restart, or a second worker. */
const workerWith = (
  client: () => ModelClient,
  opts: { leaseMs?: number; maxAttempts?: number } = {},
) =>
  createWorker({
    pool,
    events,
    agents: { drafter: entry(client) },
    onError: (_, err) => errors.push(err),
    ...opts,
  });
const writerModel = () => createScriptedModel(writer());
/** A model that stops when the writer would take its turn number `at` (0 is the first). */
const stopsAt = (at: number, stop: () => Promise<never>) => (): ModelClient => {
  const inner = writerModel();
  let stopped = false;
  return {
    async complete(req, onToken) {
      if (!stopped && req.messages.filter((m) => m.role === "assistant").length === at) {
        stopped = true;
        return stop();
      }
      return inner.complete(req, onToken);
    },
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventsUntil(runId: string, done: (events: RunEvent[]) => boolean) {
  for (let i = 0; i < 200; i++) {
    const all = await events.read(runId, 0);
    if (done(all)) return all;
    await sleep(25);
  }
  throw new Error(`run ${runId} did not get there: ${errors.map(String).join("; ")}`);
}
const lastType = (type: RunEvent["type"]) => (es: RunEvent[]) => es.at(-1)?.type === type;
const runRow = (runId: string) =>
  withTenant(pool, TENANT, async (db) => {
    const { rows } = await db.query(
      "select status, lease_owner, lease_until, attempts, decision, model from runs where id = $1",
      [runId],
    );
    return rows[0] as {
      status: string;
      lease_owner: string | null;
      lease_until: Date | null;
      attempts: number;
      decision: unknown;
      model: string | null;
    };
  });
const insertRun = (runId: string, leaseOwner: string) =>
  withTenant(pool, TENANT, (db) =>
    db.query(
      `insert into runs (id, tenant_id, agent_id, status, input, lease_owner, lease_until)
       values ($1, $2, 'drafter', 'running', $3, $4, now() - interval '1 second')`,
      [runId, TENANT, INPUT, leaseOwner],
    ),
  );
const contiguous = (es: RunEvent[]) =>
  expect(es.map((e) => e.seq)).toEqual(es.map((_, i) => i + 1));
const waitingCall = (es: RunEvent[]) =>
  (
    es.findLast((e) => e.type === "approval.requested") as Extract<
      RunEvent,
      { type: "approval.requested" }
    >
  ).data.callId;
const approve = { approved: true as const, by: "editor" };

describe("workers", () => {
  it("queue a run on the model, at the effort, it was asked to use", async () => {
    const runId = await queue.start(TENANT, "drafter", INPUT, { model: "haiku@low" });
    expect(await runRow(runId)).toMatchObject({ status: "queued", model: "haiku@low" });
    // no worker is meant to run it
    await withTenant(pool, TENANT, (db) => db.query("delete from runs where id = $1", [runId]));
    await expect(
      queue.start(TENANT, "drafter", INPUT, { model: "nova-micro@high" }),
    ).rejects.toThrow("takes no effort");
  });

  it("start a queued run, and another worker finishes it once its approval is decided", async () => {
    const first = workerWith(writerModel);
    const runId = await queue.start(TENANT, "drafter", INPUT);
    expect(await runRow(runId)).toMatchObject({ status: "queued", lease_owner: null });
    expect(await first.poll()).toEqual([runId]);
    await eventsUntil(runId, lastType("approval.requested"));
    await first.idle();
    // nothing in memory holds the run now: it is saved and waiting
    expect(await runRow(runId)).toMatchObject({ status: "waiting", lease_until: null });

    const callId = waitingCall(await events.read(runId, 0));
    expect(await queue.decide("demo-football", runId, callId, approve)).toBeUndefined();
    expect(await queue.decide(TENANT, runId, "call_other", approve)).toBeUndefined();
    const lastSeen = (await events.read(runId, 0)).at(-1)?.seq;
    expect(await queue.decide(TENANT, runId, callId, approve)).toBe(lastSeen);
    expect(await queue.decide(TENANT, runId, callId, approve)).toBeUndefined();
    expect(await runRow(runId)).toMatchObject({ status: "queued", decision: approve });

    const second = workerWith(writerModel);
    expect(await second.poll()).toEqual([runId]);
    await second.idle();
    const all = await events.read(runId, 0);
    contiguous(all);
    expect(all.at(-1)).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(all.find((e) => e.type === "run.resumed")).toMatchObject({
      data: { reason: "approval", step: 3 },
    });
    // the first save after the decision took it off the run
    expect(await runRow(runId)).toMatchObject({ status: "completed", decision: null });

    const saved = await createPostgresRunStore(pool, { owner: "reader", leaseMs: 1 }).load({
      tenantId: TENANT,
      runId,
    });
    expect(saved?.messages.length).toBe(saved?.checkpoint.messages);
    expect(saved?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("pick up a run whose worker died once its lease runs out, and carry it on", async () => {
    // the worker dies while the model writes the draft (its third turn)
    const dying = stopsAt(2, async () => {
      throw new RunInterrupted("worker died");
    });
    const leaseMs = 600;
    const first = workerWith(dying, { leaseMs });
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await first.poll();
    await first.idle();
    expect(await runRow(runId)).toMatchObject({ status: "running" });

    const second = workerWith(writerModel, { leaseMs });
    expect(await second.poll()).not.toContain(runId);
    await sleep(leaseMs + 100);
    expect(await second.poll()).toContain(runId);
    const resumed = await eventsUntil(runId, lastType("approval.requested"));
    expect(resumed.find((e) => e.type === "run.resumed")).toMatchObject({
      data: { reason: "recovery", step: 2 },
    });

    expect(await queue.decide(TENANT, runId, waitingCall(resumed), approve)).toBeDefined();
    await second.poll();
    await second.idle();
    const all = await events.read(runId, 0);
    contiguous(all);
    expect(all.at(-1)).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    // the turns taken before the crash were not taken again
    expect(
      all.filter((e) => e.type === "tool.started" && e.data.tool === "topics.get"),
    ).toHaveLength(1);
  });

  it("pick up a run whose model keeps throwing transient errors, and finish it once the model recovers", async () => {
    let recovered = false;
    const inner = writerModel();
    const throttled = (): ModelClient => ({
      async complete(req, onToken, onToolInput) {
        // the first turn is answered; the second is throttled until the model "recovers"
        if (!recovered && req.messages.filter((m) => m.role === "assistant").length === 1) {
          throw new TransientModelError("Bedrock ThrottlingException: slow down");
        }
        return inner.complete(req, onToken, onToolInput);
      },
    });
    const leaseMs = 600;
    const first = workerWith(throttled, { leaseMs });
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await first.poll();
    await first.idle();
    // not failed: the error went to the worker, and the saved run waits for another try
    expect(await runRow(runId)).toMatchObject({ status: "running" });
    expect((await events.read(runId, 0)).some((e) => e.type === "run.failed")).toBe(false);
    expect(errors.at(-1)).toBeInstanceOf(TransientModelError);

    recovered = true;
    await sleep(leaseMs + 100);
    expect(await first.poll()).toContain(runId);
    const resumed = await eventsUntil(runId, lastType("approval.requested"));
    expect(resumed.find((e) => e.type === "run.resumed")).toMatchObject({
      data: { reason: "recovery" },
    });
    expect(await queue.decide(TENANT, runId, waitingCall(resumed), approve)).toBeDefined();
    await first.poll();
    await first.idle();
    const all = await events.read(runId, 0);
    contiguous(all);
    expect(all.at(-1)).toMatchObject({ type: "run.completed", data: { status: "completed" } });
  });

  it("hand their runs to another worker when they stop", async () => {
    let unblock = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    // the model is mid-call on its second turn when the worker is told to stop
    const slow = stopsAt(1, async () => {
      await blocked;
      throw new RunInterrupted("handed over");
    });
    const first = workerWith(slow);
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await first.poll();
    await eventsUntil(runId, (es) => es.some((e) => e.type === "tool.completed"));

    await first.stop(50);
    // claimable now, not when the lease would have run out, and not counted as an attempt
    expect(await runRow(runId)).toMatchObject({
      status: "running",
      lease_owner: expect.stringMatching(/\/handed-over$/),
      attempts: 0,
    });
    unblock();
    await first.idle();

    const second = workerWith(writerModel);
    expect(await second.poll()).toEqual([runId]);
    const resumed = await eventsUntil(runId, lastType("approval.requested"));
    contiguous(resumed);
    expect(resumed.find((e) => e.type === "run.resumed")).toMatchObject({
      data: { reason: "recovery" },
    });
    expect(await runRow(runId)).toMatchObject({ attempts: 1 });
    await second.idle();
  });

  it("claim each run once, and only runs of the agents they serve", async () => {
    const runId = await queue.start(TENANT, "drafter", INPUT);
    const other = createWorker({ pool, events, agents: { "other-agent": entry(writerModel) } });
    expect(await other.poll()).toEqual([]);

    const a = workerWith(writerModel);
    const b = workerWith(writerModel);
    const claims = (await Promise.all([a.poll(), b.poll()])).flat();
    expect(claims).toEqual([runId]);
    await eventsUntil(runId, lastType("approval.requested"));
    await Promise.all([a.idle(), b.idle()]);
  });

  it("give up on a run that keeps crashing", async () => {
    let calls = 0;
    const crashing: AgentEntry = {
      input: drafter.input,
      run: async () => {
        calls++;
        throw new Error("boom");
      },
    };
    const leaseMs = 200;
    const worker = createWorker({
      pool,
      events,
      agents: { drafter: crashing },
      leaseMs,
      maxAttempts: 2,
    });
    const runId = await queue.start(TENANT, "drafter", INPUT);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await worker.poll()).toEqual([runId]);
      await worker.idle();
      await sleep(leaseMs + 50);
    }
    expect(calls).toBe(2);
    expect(await runRow(runId)).toMatchObject({ status: "failed", lease_owner: null });
    expect(await events.read(runId, 0)).toMatchObject([
      {
        seq: 1,
        type: "run.failed",
        data: { reason: "error", message: "gave up after 2 attempts: boom" },
      },
    ]);
  });

  it("fail a run whose input doesn't match the agent's schema at once, not after retries", async () => {
    let started = 0;
    const counting: AgentEntry = {
      input: drafter.input,
      run: async () => {
        started++;
        throw new Error("not reached");
      },
    };
    const worker = createWorker({ pool, events, agents: { drafter: counting } });
    const runId = await queue.start(TENANT, "drafter", { topic: "t-101" });
    expect(await worker.poll()).toEqual([runId]);
    expect(started).toBe(0);
    expect(await runRow(runId)).toMatchObject({ status: "failed", lease_owner: null });
    expect((await events.read(runId, 0)).at(-1)).toMatchObject({
      type: "run.failed",
      data: { reason: "error", message: expect.stringContaining("invalid input") },
    });
  });

  it("start afresh a run that died before it began, and give up on one that died after", async () => {
    const fresh = randomUUID();
    await insertRun(fresh, "gone");
    const begun = randomUUID();
    await insertRun(begun, "gone");
    // its events began, so they can't start over at seq 1
    await events.sink().write({
      runId: begun,
      seq: 1,
      at: new Date().toISOString(),
      type: "run.started",
      data: { agentId: "drafter", agentVersion: 1, tenantId: TENANT, input: INPUT },
    });

    const sweeper = workerWith(writerModel);
    expect((await sweeper.poll()).sort()).toEqual([fresh, begun].sort());
    await sweeper.idle();
    expect(await runRow(begun)).toMatchObject({ status: "failed", lease_owner: null });
    expect((await events.read(begun, 0)).at(-1)).toMatchObject({
      seq: 2,
      type: "run.failed",
      data: { message: "the run stopped before any of its state was saved" },
    });
    expect(await runRow(fresh)).toMatchObject({ status: "waiting" });
    expect((await events.read(fresh, 0))[0]).toMatchObject({ seq: 1, type: "run.started" });
  });

  it("don't let a process that lost a run write to it", async () => {
    const runId = randomUUID();
    await withTenant(pool, TENANT, (db) =>
      db.query(
        `insert into runs (id, tenant_id, agent_id, status, input, lease_owner, lease_until)
         values ($1, $2, 'drafter', 'running', '{}', 'the-new-owner', now() + interval '1 minute')`,
        [runId, TENANT],
      ),
    );
    const stale = createPostgresRunStore(pool, { owner: "the-old-owner", leaseMs: 60_000 });
    const checkpoint: RunCheckpoint = {
      version: 1,
      agentId: "drafter",
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
      messages: 1,
      lastSeq: 0,
      invalidOutputs: 0,
      blockedFinishes: 0,
      wrote: false,
      pendingChanges: {},
    };
    await expect(
      stale.save({ tenantId: TENANT, runId }, checkpoint, [{ role: "user", content: "x" }]),
    ).rejects.toThrow(RunInterrupted);
    expect(await stale.load({ tenantId: TENANT, runId })).toBeUndefined();
  });
});

describe("cancelling a run", () => {
  it("ends a queued run at once, and no worker ever claims it", async () => {
    const runId = await queue.start(TENANT, "drafter", INPUT);
    expect(await queue.cancel(TENANT, runId, "editor", "wrong topic")).toBe("queued");
    expect(await runRow(runId)).toMatchObject({ status: "cancelled" });
    expect((await events.read(runId, 0)).at(-1)).toMatchObject({
      type: "run.cancelled",
      data: { by: "editor", reason: "wrong topic" },
    });
    expect(await workerWith(writerModel).poll()).not.toContain(runId);
    // an ended run can't be cancelled again
    expect(await queue.cancel(TENANT, runId, "editor")).toBeUndefined();
  });

  it("ends a run waiting for an approval at once, and a later decision finds nothing", async () => {
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await workerWith(writerModel).poll();
    const waiting = await eventsUntil(runId, lastType("approval.requested"));
    expect(await queue.cancel(TENANT, runId, "editor")).toBe("waiting");
    contiguous(await eventsUntil(runId, lastType("run.cancelled")));
    expect(await queue.decide(TENANT, runId, waitingCall(waiting), approve)).toBeUndefined();
    expect(await runRow(runId)).toMatchObject({ status: "cancelled" });
  });

  it("stops a running run at its next save, with run.cancelled after its events", async () => {
    // the model holds its second turn back until released, so the cancel lands mid-run
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = (): ModelClient => {
      const inner = writerModel();
      return {
        async complete(req, onToken) {
          if (req.messages.filter((m) => m.role === "assistant").length === 1) await held;
          return inner.complete(req, onToken);
        },
      };
    };
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await workerWith(holding).poll();
    await eventsUntil(runId, (es) => es.some((e) => e.type === "tool.completed"));
    expect(await queue.cancel(TENANT, runId, "editor", "closed the job")).toBe("running");
    release();

    const all = await eventsUntil(runId, lastType("run.cancelled"));
    contiguous(all);
    expect(all.some((e) => e.type === "approval.requested")).toBe(false);
    expect(all.filter((e) => e.type === "run.cancelled")).toHaveLength(1);
    expect(await runRow(runId)).toMatchObject({ status: "cancelled", lease_owner: null });
  });
});

describe("cancelling a run whose worker then died", () => {
  it("leaves it to the next worker to write run.cancelled, and nobody runs it", async () => {
    const runId = randomUUID();
    // held by a worker whose lease is about to run out, and which never saves again
    await withTenant(pool, TENANT, (db) =>
      db.query(
        `insert into runs (id, tenant_id, agent_id, status, input, lease_owner, lease_until)
         values ($1, $2, 'drafter', 'running', $3, 'dead-worker/x', now() + interval '300 milliseconds')`,
        [runId, TENANT, INPUT],
      ),
    );
    expect(await queue.cancel(TENANT, runId, "editor")).toBe("running");
    expect(await events.read(runId, 0)).toEqual([]);
    await sleep(400);

    expect(await workerWith(writerModel).poll()).toContain(runId);
    const all = await eventsUntil(runId, lastType("run.cancelled"));
    expect(all.map((e) => e.type)).toEqual(["run.cancelled"]);
    expect(await runRow(runId)).toMatchObject({ status: "cancelled", lease_owner: null });
    // let go, it is never claimed again
    expect(await workerWith(writerModel).poll()).not.toContain(runId);
  });
});

describe("save points and forks", () => {
  const reject = { approved: false as const, by: "editor", reason: "not this one" };
  /** Runs `runId` until it waits for its approval, and returns its events. */
  const untilWaiting = async (worker: ReturnType<typeof workerWith>, runId: string) => {
    await worker.poll();
    const es = await eventsUntil(runId, lastType("approval.requested"));
    await worker.idle();
    return es;
  };
  const stored = (runId: string) =>
    withTenant(pool, TENANT, async (db) => {
      const { rows } = await db.query<{ type: string; seq: number; data: unknown }>(
        "select type, seq, data from run_events where run_id = $1 order by seq",
        [runId],
      );
      return rows;
    });

  it("lists every save point, and forks a run at its approval with the other decision; both end, neither changes the other", async () => {
    const worker = workerWith(writerModel);
    const runId = await queue.start(TENANT, "drafter", INPUT);
    const parentEvents = await untilWaiting(worker, runId);

    const history = await queue.history(TENANT, runId);
    expect(history.map((p) => p.version)).toEqual(history.map((_, i) => i + 1));
    expect(history[0]).toMatchObject({ step: 0, savedAfter: "start", messages: 2 });
    const waiting = history.at(-1) as (typeof history)[number];
    expect(waiting).toMatchObject({
      step: 3,
      savedAfter: "waiting",
      waiting: { tool: "draft.save" },
    });

    const { runId: forkId, startSeq } = await queue.fork(TENANT, runId, waiting.version, {
      decision: reject,
    });
    expect(await queue.find(TENANT, forkId)).toMatchObject({
      status: "queued",
      parent_run_id: runId,
      parent_version: waiting.version,
    });
    expect(await worker.poll()).toEqual([forkId]);
    const forkEvents = await eventsUntil(forkId, lastType("run.completed"));
    await worker.idle();
    // the parent's record up to the save point (tokens are never stored), then the fork's own
    const upTo = (rows: Awaited<ReturnType<typeof stored>>) =>
      rows.filter((e) => e.seq <= startSeq);
    expect(upTo(await stored(forkId))).toEqual(upTo(await stored(runId)));
    expect(upTo(await stored(forkId)).at(-1)?.type).toBe("approval.requested");
    expect(forkEvents[0]).toMatchObject({
      seq: startSeq + 1,
      type: "run.resumed",
      data: { reason: "fork", forkedFrom: { runId, version: waiting.version } },
    });
    expect(forkEvents.at(-1)).toMatchObject({ data: { status: "rejected" } });
    // the parent still waits, as it was
    expect(await runRow(runId)).toMatchObject({ status: "waiting" });
    expect(await queue.history(TENANT, runId)).toEqual(history);

    await queue.decide(TENANT, runId, waitingCall(parentEvents), approve);
    await worker.poll();
    await eventsUntil(runId, lastType("run.completed"));
    await worker.idle();
    expect((await queue.find(TENANT, runId))?.status).toBe("completed");
    expect((await queue.find(TENANT, forkId))?.status).toBe("rejected");
  });

  it("forks onto another model, or with a corrected input between turns", async () => {
    const sent: string[] = [];
    const recording = (): ModelClient => {
      const inner = writerModel();
      return {
        complete(req, onToken, onToolInput) {
          sent.push(req.model);
          return inner.complete(req, onToken, onToolInput);
        },
      };
    };
    const worker = workerWith(recording);
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await untilWaiting(worker, runId);
    const history = await queue.history(TENANT, runId);
    const firstTurn = history.find((p) => p.step === 1 && p.savedAfter === "tool" && !p.waiting);

    sent.length = 0;
    const onHaiku = await queue.fork(TENANT, runId, firstTurn?.version ?? 0, { model: "haiku" });
    await worker.poll();
    await eventsUntil(onHaiku.runId, lastType("approval.requested"));
    await worker.idle();
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set(["haiku"]));

    const corrected = await queue.fork(TENANT, runId, 1, { input: { topicId: "t-102" } });
    expect(await queue.find(TENANT, corrected.runId)).toMatchObject({
      status: "queued",
      input: { topicId: "t-102" },
    });
    const { rows } = await withTenant(pool, TENANT, (db) =>
      db.query<{ message: { content: string } }>(
        "select message from run_messages where run_id = $1 order by idx desc limit 1",
        [corrected.runId],
      ),
    );
    expect(rows[0]?.message.content).toBe(correctedInput({ topicId: "t-102" }));

    await expect(queue.fork(TENANT, runId, 1, { model: "gpt" })).rejects.toThrow(
      "no model named gpt",
    );
    await expect(queue.fork(TENANT, runId, 999)).rejects.toThrow("has no save point 999");
    await expect(queue.fork("demo-football", runId, 1)).rejects.toThrow("has no save point 1");
  });

  it("prunes save points past their time, but never a run's latest", async () => {
    const worker = createWorker({ pool, events, agents: {}, historyDays: 0 });
    const runId = await queue.start(TENANT, "drafter", INPUT);
    await untilWaiting(workerWith(writerModel), runId);
    const before = await queue.history(TENANT, runId);
    expect(before.length).toBeGreaterThan(1);
    expect(await worker.prune()).toBeGreaterThanOrEqual(before.length - 1);
    expect(await queue.history(TENANT, runId)).toEqual([before.at(-1)]);
    // the latest is still there to fork from
    expect((await queue.fork(TENANT, runId, before.length)).runId).toBeDefined();
  });
});
