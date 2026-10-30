import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent as matchPreview } from "@dugout/agent-match-preview";
import type { ModelClient, RunCheckpoint, RunEvent } from "@dugout/contracts";
import { createScriptedModel, RunInterrupted, scriptedModelConfig } from "@dugout/core";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
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
const INPUT = { fixtureId: "c-101" };
let runsDir: string;
const errors: unknown[] = [];

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "runs-worker-"));
  await matchPreview.seed(memory, [TENANT]);
});
afterAll(async () => {
  await pool.end();
  valkey.disconnect();
});

const entry = (client: () => ModelClient): AgentEntry => ({
  input: matchPreview.input,
  run: (opts) =>
    matchPreview.create({
      store: memory,
      client: client(),
      models: scriptedModelConfig(),
      runsDir,
      draftsDir: join(runsDir, "drafts"),
      consolidate: false,
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
    agents: { "match-preview": entry(client) },
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
      "select status, lease_owner, lease_until, attempts, decision from runs where id = $1",
      [runId],
    );
    return rows[0] as {
      status: string;
      lease_owner: string | null;
      lease_until: Date | null;
      attempts: number;
      decision: unknown;
    };
  });
const insertRun = (runId: string, leaseOwner: string) =>
  withTenant(pool, TENANT, (db) =>
    db.query(
      `insert into runs (id, tenant_id, agent_id, status, input, lease_owner, lease_until)
       values ($1, $2, 'match-preview', 'running', $3, $4, now() - interval '1 second')`,
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
  it("start a queued run, and another worker finishes it once its approval is decided", async () => {
    const first = workerWith(writerModel);
    const runId = await queue.start(TENANT, "match-preview", INPUT);
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
    const runId = await queue.start(TENANT, "match-preview", INPUT);
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
      all.filter((e) => e.type === "tool.started" && e.data.tool === "fixtures.get"),
    ).toHaveLength(1);
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
    const runId = await queue.start(TENANT, "match-preview", INPUT);
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
    const runId = await queue.start(TENANT, "match-preview", INPUT);
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
      input: matchPreview.input,
      run: async () => {
        calls++;
        throw new Error("boom");
      },
    };
    const leaseMs = 200;
    const worker = createWorker({
      pool,
      events,
      agents: { "match-preview": crashing },
      leaseMs,
      maxAttempts: 2,
    });
    const runId = await queue.start(TENANT, "match-preview", INPUT);
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
      input: matchPreview.input,
      run: async () => {
        started++;
        throw new Error("not reached");
      },
    };
    const worker = createWorker({ pool, events, agents: { "match-preview": counting } });
    const runId = await queue.start(TENANT, "match-preview", { fixture: "c-101" });
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
      data: { agentId: "match-preview", agentVersion: 1, tenantId: TENANT, input: INPUT },
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
         values ($1, $2, 'match-preview', 'running', '{}', 'the-new-owner', now() + interval '1 minute')`,
        [runId, TENANT],
      ),
    );
    const stale = createPostgresRunStore(pool, { owner: "the-old-owner", leaseMs: 60_000 });
    const checkpoint: RunCheckpoint = {
      version: 1,
      agentId: "match-preview",
      agentVersion: 1,
      step: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
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
      pendingChanges: {},
    };
    await expect(
      stale.save({ tenantId: TENANT, runId }, checkpoint, [{ role: "user", content: "x" }]),
    ).rejects.toThrow(RunInterrupted);
    expect(await stale.load({ tenantId: TENANT, runId })).toBeUndefined();
  });
});
