import { randomUUID } from "node:crypto";
import type { Decision, RunEvent } from "@dugout/contracts";
import { type ForkChange, forkRun, loadModelConfig, modelEntry } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import { readStoredEvents, type ValkeyEventLog } from "./event-log.ts";
import { appendEnding, cancelledEvent, lastSeq } from "./records.ts";
import { loadRun, runHistory, writeFork } from "./run-store.ts";

export interface RunRow {
  id: string;
  agent_id: string;
  status: "queued" | "running" | "waiting" | "completed" | "rejected" | "failed" | "cancelled";
  input: unknown;
  result: unknown;
  /** The run it was forked from, and at which save point. */
  parent_run_id: string | null;
  parent_version: number | null;
  /** The model it runs on instead of its spec's. */
  model: string | null;
  /** The thread it is in (migration 019): the top level a person sees. */
  thread_id: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, agent_id, status, input, result, parent_run_id, parent_version, model, thread_id, created_at, updated_at";

const ENDED = new Set<RunRow["status"]>(["completed", "rejected", "failed", "cancelled"]);

/**
 * How a host hands runs to the workers (ADR 0009): it queues runs and approval decisions in
 * Postgres and reads the runs' events back. It never runs an agent. In this repo the CLI is the
 * host; in production it is wnm-fanxp-backend, which does the same against the same tables.
 */
export function createRunQueue(opts: { pool: Pool; events: ValkeyEventLog }) {
  const find = (tenantId: string, runId: string) =>
    withTenant(opts.pool, tenantId, async (db) => {
      const { rows } = await db.query<RunRow>(`select ${COLUMNS} from runs where id = $1`, [runId]);
      return rows[0];
    });

  return {
    find,

    /** The tenant's runs whose id starts with `prefix`, newest first; all of them for "". */
    matching: (tenantId: string, prefix: string, limit = 10) =>
      withTenant(opts.pool, tenantId, async (db) => {
        // ids are UUIDs: anything else can't match, and can't carry a LIKE wildcard
        if (!/^[0-9a-f-]*$/i.test(prefix)) return [];
        const { rows } = await db.query<RunRow>(
          `select ${COLUMNS} from runs where id like $1 order by updated_at desc limit $2`,
          [`${prefix.toLowerCase()}%`, limit],
        );
        return rows;
      }),

    /**
     * Queues a run; a worker starts it. The input must already be checked against the agent's
     * schema. `model` is a name in the model list, with an effort as `name@effort`, run in place of
     * the spec's. `threadId` puts it in a thread of the tenant's; without one it is in the thread of
     * the run that published the preview it works on, or starts a thread (the `runs_thread`
     * trigger).
     */
    async start(
      tenantId: string,
      agentId: string,
      input: unknown,
      options: { model?: string; threadId?: string } = {},
    ) {
      if (options.model) modelEntry(loadModelConfig(), options.model);
      const runId = randomUUID();
      await withTenant(opts.pool, tenantId, async (db) => {
        if (options.threadId) {
          const { rowCount } = await db.query("select 1 from threads where id = $1", [
            options.threadId,
          ]);
          if (!rowCount) throw new Error(`no thread ${options.threadId} for tenant ${tenantId}`);
        }
        await db.query(
          `insert into runs (id, tenant_id, agent_id, status, input, model, thread_id)
           values ($1, $2, $3, 'queued', $4, $5, $6)`,
          [runId, tenantId, agentId, input, options.model ?? null, options.threadId ?? null],
        );
      });
      return runId;
    },

    /** The thread's runs, oldest first: its invocations and their children. */
    thread: (tenantId: string, threadId: string) =>
      withTenant(opts.pool, tenantId, async (db) => {
        const { rows } = await db.query<RunRow & { parent_call_id: string | null }>(
          `select ${COLUMNS}, parent_call_id from runs where thread_id = $1 order by created_at`,
          [threadId],
        );
        return rows;
      }),

    /**
     * Queues the run again with the decision on the approval it waits for; a worker resumes it.
     * Returns the last `seq` before the decision, to follow the resumed run from. Undefined when the
     * run is not waiting for this call (already decided, another call, another tenant).
     */
    async decide(tenantId: string, runId: string, callId: string, decision: Decision) {
      const queued = await withTenant(opts.pool, tenantId, async (db) => {
        // the update checks the waiting call in the same statement, so two decisions can't both win
        const { rowCount } = await db.query(
          `update runs r
           set status = 'queued', decision = $3, attempts = 0, last_error = null,
               lease_owner = null, lease_until = null, updated_at = now()
           from run_checkpoints c
           where r.id = $1 and c.run_id = r.id and r.status = 'waiting'
             and c.checkpoint -> 'waiting' ->> 'callId' = $2`,
          [runId, callId, decision],
        );
        return rowCount === 1;
      });
      return queued ? await lastSeq(opts.pool, opts.events, tenantId, runId) : undefined;
    },

    /**
     * Cancels a queued, running or waiting run. A queued or waiting run, or a running one whose
     * worker is gone, ends at once with `run.cancelled`. A running one stops at its worker's next
     * save, and the worker writes `run.cancelled`. Returns the status the run had, or undefined
     * when it had already ended (or is another tenant's).
     */
    async cancel(tenantId: string, runId: string, by: string, reason?: string) {
      const row = await withTenant(opts.pool, tenantId, async (db) => {
        const { rows } = await db.query<{ previous: RunRow["status"]; held: boolean }>(
          `with old as (select id, status, lease_until from runs where id = $1 for update)
           update runs r
           set status = 'cancelled', cancelled_by = $2, cancel_reason = $3, decision = null,
               updated_at = now(),
               -- no worker holds it: this call ends it, and nothing should claim it after
               lease_owner = case when old.status = 'running' and old.lease_until > now()
                 then r.lease_owner end,
               lease_until = case when old.status = 'running' and old.lease_until > now()
                 then r.lease_until end
           from old
           where r.id = old.id and old.status in ('queued', 'running', 'waiting')
           returning old.status as previous,
             (old.status = 'running' and old.lease_until > now()) as held`,
          [runId, by, reason ?? null],
        );
        return rows[0];
      });
      if (!row) return undefined;
      if (!row.held) {
        await appendEnding(
          opts.pool,
          opts.events,
          tenantId,
          runId,
          cancelledEvent(runId, by, reason),
        );
      }
      return row.previous;
    },

    /** Every save point of the run still kept, oldest first (harness 16). */
    history: (tenantId: string, runId: string) => runHistory(opts.pool, { tenantId, runId }),

    /**
     * Queues a follow-up to run `parentId`: a new run of the same agent that carries on from the
     * parent's latest save point (its transcript, then `input` as a corrected input). The worker
     * writes the carried state when it claims the run, so a host that only inserts a row (the
     * backend) can do the same. The parent must have ended: a follow-up goes between turns.
     */
    async continueFrom(
      tenantId: string,
      parentId: string,
      input: unknown,
      options: { model?: string } = {},
    ) {
      const parent = await find(tenantId, parentId);
      if (!parent) throw new Error(`no run ${parentId} for tenant ${tenantId}`);
      if (!ENDED.has(parent.status)) throw new Error(`run ${parentId} has not ended`);
      const runId = randomUUID();
      await withTenant(opts.pool, tenantId, (db) =>
        db.query(
          `insert into runs (id, tenant_id, agent_id, status, input, parent_run_id, model)
           values ($1, $2, $3, 'queued', $4, $5, $6)`,
          [
            runId,
            tenantId,
            parent.agent_id,
            JSON.stringify(input),
            parentId,
            options.model ?? parent.model,
          ],
        ),
      );
      return runId;
    },

    /**
     * Queues a new run that carries on from save point `from` of run `runId`: the parent's
     * transcript and events up to that point, then the change. The decision on the approval the
     * save point waits for (perhaps the other one), a corrected input, or another model; with no
     * change it simply runs again from there. A fork at an approval with no decision waits for
     * one. The parent is left as it is. Returns the fork's id and the last `seq` it starts with.
     */
    async fork(
      tenantId: string,
      runId: string,
      from: number,
      change: ForkChange & { model?: string } = {},
    ) {
      if (change.model) modelEntry(loadModelConfig(), change.model);
      const parent = await find(tenantId, runId);
      const saved = parent && (await loadRun(opts.pool, { tenantId, runId }, from));
      if (!parent || !saved) throw new Error(`run ${runId} has no save point ${from}`);
      const forked = forkRun(saved, { runId, version: from }, change);
      const fork = randomUUID();
      const status = forked.checkpoint.waiting && !change.decision ? "waiting" : "queued";
      await withTenant(opts.pool, tenantId, async (db) => {
        await db.query(
          `insert into runs (id, tenant_id, agent_id, status, input, decision, parent_run_id,
             parent_version, model)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            fork,
            tenantId,
            parent.agent_id,
            status,
            JSON.stringify(change.input ?? parent.input),
            change.decision ? JSON.stringify(change.decision) : null,
            runId,
            from,
            change.model ?? parent.model,
          ],
        );
        await writeFork(db, tenantId, fork, runId, forked);
      });
      return { runId: fork, startSeq: forked.checkpoint.lastSeq };
    },

    /** The call the run waits for a decision on, if it is waiting. */
    waitingFor: (tenantId: string, runId: string) =>
      withTenant(opts.pool, tenantId, async (db) => {
        const { rows } = await db.query<{ call_id: string }>(
          `select c.checkpoint -> 'waiting' ->> 'callId' as call_id
           from runs r join run_checkpoints c on c.run_id = r.id
           where r.id = $1 and r.status = 'waiting'`,
          [runId],
        );
        return rows[0]?.call_id;
      }),

    /**
     * The run's events after `afterSeq`: the live stream, until `stopAt` matches an event, the run
     * ends, or `signal` aborts. A run that ended and whose live stream has expired replays from
     * Postgres, without the streamed fragments. A queued run has no stream yet; following it waits
     * for a worker to start one.
     */
    async *follow(
      tenantId: string,
      runId: string,
      afterSeq: number,
      signal: AbortSignal,
      stopAt?: (e: RunEvent) => boolean,
    ): AsyncGenerator<RunEvent> {
      const run = await find(tenantId, runId);
      if (!run) throw new Error(`no run ${runId} for tenant ${tenantId}`);
      if (ENDED.has(run.status) && !(await opts.events.exists(runId))) {
        yield* await readStoredEvents(opts.pool, tenantId, runId, afterSeq);
        return;
      }
      yield* opts.events.follow(runId, afterSeq, signal, stopAt);
    },
  };
}

export type RunQueue = ReturnType<typeof createRunQueue>;
