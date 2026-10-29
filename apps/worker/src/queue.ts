import { randomUUID } from "node:crypto";
import type { ApprovalDecision, RunEvent } from "@dugout/contracts";
import { type Pool, withTenant } from "@dugout/db";
import { readStoredEvents, type ValkeyEventLog } from "./event-log.ts";
import { lastSeq } from "./records.ts";

export interface RunRow {
  id: string;
  agent_id: string;
  status: "queued" | "running" | "waiting" | "completed" | "rejected" | "failed";
  input: unknown;
  result: unknown;
  created_at: Date;
  updated_at: Date;
}

const ENDED = new Set<RunRow["status"]>(["completed", "rejected", "failed"]);

/**
 * How a host hands runs to the workers (ADR 0009): it queues runs and approval decisions in
 * Postgres and reads the runs' events back. It never runs an agent. In this repo the CLI is the
 * host; in production it is wnm-fanxp-backend, which does the same against the same tables.
 */
export function createRunQueue(opts: { pool: Pool; events: ValkeyEventLog }) {
  const find = (tenantId: string, runId: string) =>
    withTenant(opts.pool, tenantId, async (db) => {
      const { rows } = await db.query<RunRow>(
        "select id, agent_id, status, input, result, created_at, updated_at from runs where id = $1",
        [runId],
      );
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
          `select id, agent_id, status, input, result, created_at, updated_at from runs
           where id like $1 order by updated_at desc limit $2`,
          [`${prefix.toLowerCase()}%`, limit],
        );
        return rows;
      }),

    /** Queues a run; a worker starts it. The input must already be checked against the agent's schema. */
    async start(tenantId: string, agentId: string, input: unknown) {
      const runId = randomUUID();
      await withTenant(opts.pool, tenantId, (db) =>
        db.query(
          `insert into runs (id, tenant_id, agent_id, status, input)
           values ($1, $2, $3, 'queued', $4)`,
          [runId, tenantId, agentId, input],
        ),
      );
      return runId;
    },

    /**
     * Queues the run again with the decision on the approval it waits for; a worker resumes it.
     * Returns the last `seq` before the decision, to follow the resumed run from. Undefined when the
     * run is not waiting for this call (already decided, another call, another tenant).
     */
    async decide(tenantId: string, runId: string, callId: string, decision: ApprovalDecision) {
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
