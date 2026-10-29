import { randomUUID } from "node:crypto";
import type { ApprovalDecision, EventSink, RunEvent, RunStore } from "@dugout/contracts";
import { type Approver, RunInterrupted } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import type { z } from "zod";
import { createPostgresEventSink, readStoredEvents, type ValkeyEventLog } from "./event-log.ts";
import { createPostgresRunStore } from "./run-store.ts";

/** How a run is carried on from its saved state. */
export interface ResumeOptions {
  reason: "approval" | "recovery";
  decision?: ApprovalDecision;
  /** The last `seq` the event log already has. */
  startSeq: number;
  /** The run's earlier events, for memory consolidation at the end. */
  events: RunEvent[];
}

/** How the API starts (or resumes) one kind of agent. */
export interface AgentEntry {
  input: z.ZodType;
  run(opts: {
    tenantId: string;
    input: never;
    approver: Approver;
    runId: string;
    sinks: EventSink[];
    store: RunStore;
    resume?: ResumeOptions;
  }): Promise<unknown>;
}

/** Approvals in the API wait for a person: the run saves its state and ends; a decision resumes it. */
const later: Approver = async () => ({ pending: true });

/**
 * Starts runs in this process, resumes them when an approval is decided, and picks up runs whose
 * process died (ADR 0006). A run's working memory lives in Postgres, so any API process can carry
 * it on: the one that holds its lease does, and a lease that runs out frees the run for another.
 */
export function createRunManager(opts: {
  pool: Pool;
  events: ValkeyEventLog;
  agents: Record<string, AgentEntry>;
  onError?: (runId: string, err: unknown) => void;
  /** This process, as lease holder. */
  owner?: string;
  /** How long a lease lasts without being renewed. Renewed on every save and a third of the way in. */
  leaseMs?: number;
}) {
  const owner = opts.owner ?? `api-${randomUUID().slice(0, 8)}`;
  const leaseMs = opts.leaseMs ?? 60_000;
  const inFlight = new Set<Promise<unknown>>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  // A lease belongs to one invocation, not to the process: when a decision resumes a run, the
  // invocation that saved the wait (still finishing, maybe) can no longer write to it.
  const newLease = () => `${owner}/${randomUUID().slice(0, 8)}`;

  const renew = (tenantId: string, runId: string, lease: string) =>
    withTenant(opts.pool, tenantId, (db) =>
      db.query(
        `update runs set lease_until = now() + make_interval(secs => $3)
         where id = $1 and lease_owner = $2 and status = 'running'`,
        [runId, lease, leaseMs / 1000],
      ),
    );

  /** Marks a run that cannot go on as failed, without an event log to write to. */
  const abandon = (tenantId: string, runId: string, message: string) =>
    withTenant(opts.pool, tenantId, (db) =>
      db.query(
        "update runs set status = 'failed', result = $2, lease_owner = null, lease_until = null, updated_at = now() where id = $1",
        [runId, { reason: "error", message }],
      ),
    );

  /** The last `seq` the run's events reached, live stream (tokens) or permanent record. */
  const lastSeq = async (tenantId: string, runId: string) => {
    const stored = await withTenant(opts.pool, tenantId, (db) =>
      db.query<{ seq: number }>(
        "select coalesce(max(seq), 0) as seq from run_events where run_id = $1",
        [runId],
      ),
    );
    return Math.max(stored.rows[0]?.seq ?? 0, await opts.events.lastSeq(runId));
  };

  /** One invocation of a run, holding `lease` until it ends, waits or is taken over. */
  const launch = (
    lease: string,
    tenantId: string,
    agentId: string,
    runId: string,
    input: unknown,
    resume?: ResumeOptions,
  ) => {
    const agent = opts.agents[agentId];
    if (!agent) return abandon(tenantId, runId, `unknown agent ${agentId}`);
    const heartbeat = setInterval(
      () => void renew(tenantId, runId, lease).catch((err) => opts.onError?.(runId, err)),
      leaseMs / 3,
    );
    const run = agent
      .run({
        tenantId,
        input: input as never,
        approver: later,
        runId,
        sinks: [opts.events.sink(), createPostgresEventSink(opts.pool, tenantId)],
        store: createPostgresRunStore(opts.pool, { owner: lease, leaseMs }),
        ...(resume ? { resume } : {}),
      })
      // another process holds the run now; this invocation just stops
      .catch((err) => (err instanceof RunInterrupted ? undefined : opts.onError?.(runId, err)))
      .finally(() => {
        clearInterval(heartbeat);
        inFlight.delete(run);
      });
    inFlight.add(run);
    return run;
  };

  /** Loads what a resumed invocation needs besides the saved state, and starts it. */
  const carryOn = async (
    lease: string,
    tenantId: string,
    runId: string,
    agentId: string,
    input: unknown,
    reason: ResumeOptions["reason"],
    decision?: ApprovalDecision,
  ) => {
    const [startSeq, events] = await Promise.all([
      lastSeq(tenantId, runId),
      readStoredEvents(opts.pool, tenantId, runId, 0),
    ]);
    void launch(lease, tenantId, agentId, runId, input, {
      reason,
      startSeq,
      events,
      ...(decision ? { decision } : {}),
    });
  };

  const manager = {
    owner,
    agentIds: () => Object.keys(opts.agents),

    async start(tenantId: string, agentId: string, rawInput: unknown) {
      const agent = opts.agents[agentId];
      if (!agent) throw new RunError(404, `unknown agent ${agentId}`);
      const parsed = agent.input.safeParse(rawInput);
      if (!parsed.success) throw new RunError(400, `invalid input: ${parsed.error.message}`);

      const runId = randomUUID();
      const lease = newLease();
      await withTenant(opts.pool, tenantId, (db) =>
        db.query(
          `insert into runs (id, tenant_id, agent_id, status, input, lease_owner, lease_until)
           values ($1, $2, $3, 'running', $4, $5, now() + make_interval(secs => $6))`,
          [runId, tenantId, agentId, parsed.data, lease, leaseMs / 1000],
        ),
      );
      void launch(lease, tenantId, agentId, runId, parsed.data);
      return runId;
    },

    /**
     * Decides the approval a run is waiting for and resumes it in this process. False when the run
     * is not waiting for this call (already decided, another call, another tenant).
     */
    async decide(tenantId: string, runId: string, callId: string, decision: ApprovalDecision) {
      const lease = newLease();
      const claimed = await withTenant(opts.pool, tenantId, async (db) => {
        // the claim checks the waiting call in the same statement, so two decisions can't both win
        const { rows } = await db.query<{ agent_id: string; input: unknown }>(
          `update runs r
           set status = 'running', lease_owner = $3,
               lease_until = now() + make_interval(secs => $4), updated_at = now()
           from run_checkpoints c
           where r.id = $1 and c.run_id = r.id and r.status = 'waiting'
             and c.checkpoint -> 'waiting' ->> 'callId' = $2
           returning r.agent_id, r.input`,
          [runId, callId, lease, leaseMs / 1000],
        );
        return rows[0];
      });
      if (!claimed) return false;
      await carryOn(lease, tenantId, runId, claimed.agent_id, claimed.input, "approval", decision);
      return true;
    },

    /** Claims runs whose lease ran out (their process died) and carries them on here. */
    async recover(maxRuns = 10) {
      const { rows } = await opts.pool.query<{ run_id: string; tenant_id: string }>(
        "select run_id, tenant_id from claim_expired_runs($1, make_interval(secs => $2), $3)",
        [owner, leaseMs / 1000, maxRuns],
      );
      for (const { run_id: runId, tenant_id: tenantId } of rows) {
        try {
          // the sweep claimed it for this process; this invocation takes it over
          const lease = newLease();
          const run = await withTenant(opts.pool, tenantId, async (db) => {
            const found = await db.query<{ agent_id: string; input: unknown; saved: boolean }>(
              `update runs r set lease_owner = $3
               where r.id = $1 and r.lease_owner = $2
               returning r.agent_id, r.input,
                 exists (select 1 from run_checkpoints where run_id = r.id) as saved`,
              [runId, owner, lease],
            );
            return found.rows[0];
          });
          if (!run) continue;
          if (!run?.saved) {
            await abandon(tenantId, runId, "the run stopped before any of its state was saved");
            continue;
          }
          await carryOn(lease, tenantId, runId, run.agent_id, run.input, "recovery");
        } catch (err) {
          opts.onError?.(runId, err);
        }
      }
      return rows.map((r) => r.run_id);
    },

    /** Runs `recover` now and then every `everyMs`, until `stop`. */
    startRecovery(everyMs = leaseMs / 2) {
      const sweep = () => void manager.recover().catch((err) => opts.onError?.("recovery", err));
      sweep();
      sweeper = setInterval(sweep, everyMs);
    },

    stop() {
      if (sweeper) clearInterval(sweeper);
    },

    /** Waits for every invocation started so far; for tests and graceful shutdown. */
    idle: () => Promise.all([...inFlight]),
  };
  return manager;
}

export type RunManager = ReturnType<typeof createRunManager>;

export class RunError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
