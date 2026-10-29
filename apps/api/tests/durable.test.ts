import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatchPreview, Input, seedHouseStyle } from "@dugout/agent-match-preview";
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
  createRunManager,
  createValkeyEventLog,
} from "../src/index.ts";
import { writer } from "./fixtures.ts";

const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const memory = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
const TENANT = "demo-cricket";
let runsDir: string;
const errors: unknown[] = [];

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "api-durable-"));
  await seedHouseStyle(memory, [TENANT]);
});
afterAll(async () => {
  await pool.end();
  valkey.disconnect();
});

const agents = (client: () => ModelClient): Record<string, AgentEntry> => ({
  "match-preview": {
    input: Input,
    run: (opts) =>
      createMatchPreview({
        store: memory,
        client: client(),
        models: scriptedModelConfig(),
        runsDir,
        draftsDir: join(runsDir, "drafts"),
        consolidate: false,
      })(opts),
  },
});
/** One API process. Two of them with the same database are a restart, or a second server. */
const apiProcess = (client: () => ModelClient, leaseMs = 60_000) =>
  createRunManager({
    pool,
    events,
    agents: agents(client),
    leaseMs,
    onError: (_, err) => errors.push(err),
  });
const writerModel = () => createScriptedModel(writer());

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
      "select status, lease_owner, lease_until from runs where id = $1",
      [runId],
    );
    return rows[0] as { status: string; lease_owner: string | null; lease_until: Date | null };
  });
const contiguous = (es: RunEvent[]) =>
  expect(es.map((e) => e.seq)).toEqual(es.map((_, i) => i + 1));
const waitingCall = (es: RunEvent[]) =>
  (
    es.findLast((e) => e.type === "approval.requested") as Extract<
      RunEvent,
      { type: "approval.requested" }
    >
  ).data.callId;

describe("runs that outlive their process", () => {
  it("decides a waiting run in another process and finishes it there", async () => {
    const first = apiProcess(writerModel);
    const runId = await first.start(TENANT, "match-preview", { fixtureId: "c-101" });
    await eventsUntil(runId, lastType("approval.requested"));
    await first.idle();
    // nothing in memory holds the run now: it is saved and waiting
    expect(await runRow(runId)).toMatchObject({ status: "waiting", lease_until: null });

    const second = apiProcess(writerModel);
    const callId = waitingCall(await events.read(runId, 0));
    const approve = { approved: true as const, by: "editor" };
    expect(await second.decide("demo-football", runId, callId, approve)).toBe(false);
    expect(await second.decide(TENANT, runId, "call_other", approve)).toBe(false);
    expect(await second.decide(TENANT, runId, callId, approve)).toBe(true);
    expect(await second.decide(TENANT, runId, callId, approve)).toBe(false);
    await second.idle();

    const all = await events.read(runId, 0);
    contiguous(all);
    expect(all.at(-1)).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(all.find((e) => e.type === "run.resumed")).toMatchObject({
      data: { reason: "approval", step: 3 },
    });
    expect(await runRow(runId)).toMatchObject({ status: "completed" });

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

  it("picks up a run whose process died once its lease runs out, and carries it on", async () => {
    let died = false;
    // the process dies while the model writes the draft (its third turn)
    const dying = (): ModelClient => {
      const inner = writerModel();
      return {
        async complete(req, onToken) {
          if (!died && req.messages.filter((m) => m.role === "assistant").length === 2) {
            died = true;
            throw new RunInterrupted("process died");
          }
          return inner.complete(req, onToken);
        },
      };
    };
    const leaseMs = 600;
    const first = apiProcess(dying, leaseMs);
    const runId = await first.start(TENANT, "match-preview", { fixtureId: "c-101" });
    await first.idle();
    expect(died).toBe(true);
    expect(await runRow(runId)).toMatchObject({ status: "running" });

    const second = apiProcess(writerModel, leaseMs);
    expect(await second.recover()).not.toContain(runId);
    await sleep(leaseMs + 100);
    expect(await second.recover()).toContain(runId);
    const resumed = await eventsUntil(runId, lastType("approval.requested"));
    expect(resumed.find((e) => e.type === "run.resumed")).toMatchObject({
      data: { reason: "recovery", step: 2 },
    });

    expect(
      await second.decide(TENANT, runId, waitingCall(resumed), { approved: true, by: "editor" }),
    ).toBe(true);
    await second.idle();
    const all = await events.read(runId, 0);
    contiguous(all);
    expect(all.at(-1)).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    // the turns taken before the crash were not taken again
    expect(
      all.filter((e) => e.type === "tool.started" && e.data.tool === "fixtures.get"),
    ).toHaveLength(1);
  });

  it("does not let a process that lost a run write to it", async () => {
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

  it("marks a run that died before saving anything as failed", async () => {
    const runId = randomUUID();
    await withTenant(pool, TENANT, (db) =>
      db.query(
        `insert into runs (id, tenant_id, agent_id, status, input, lease_owner, lease_until)
         values ($1, $2, 'match-preview', 'running', '{}', 'gone', now() - interval '1 second')`,
        [runId, TENANT],
      ),
    );
    const sweeper = apiProcess(writerModel);
    expect(await sweeper.recover()).toContain(runId);
    expect(await runRow(runId)).toMatchObject({ status: "failed", lease_owner: null });
  });
});
