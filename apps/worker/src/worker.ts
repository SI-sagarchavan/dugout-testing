import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "@dugout/contracts";
import { type Approver, RunInterrupted } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import { z } from "zod";
import type { AgentEntry, ResumeOptions } from "./agents.ts";
import { createChildRuns } from "./children.ts";
import { createPostgresEventSink, readStoredEvents, type ValkeyEventLog } from "./event-log.ts";
import { appendEnding, cancelledEvent, lastSeq } from "./records.ts";
import { createPostgresRunStore } from "./run-store.ts";

/** Approvals wait for a person: the run saves its state and ends; a decision queues it again. */
const later: Approver = async () => ({ pending: true });

export interface WorkerOptions {
  pool: Pool;
  events: ValkeyEventLog;
  /** The agents this worker runs, by id. It claims only their runs. */
  agents: Record<string, AgentEntry>;
  /** This process, as lease holder. */
  owner?: string;
  /** How long a lease lasts without being renewed. Renewed on every save and a third of the way in. */
  leaseMs?: number;
  /** Runs in progress at once. They mostly wait on the model, so this can be well above the CPUs. */
  concurrency?: number;
  /** Claims a run gets after it was queued before it is given up on, so a crash can't loop forever. */
  maxAttempts?: number;
  /** How long save points other than a run's latest are kept; 30 days unless set. */
  historyDays?: number;
  onError?: (runId: string, err: unknown) => void;
}

interface Claimed {
  run_id: string;
  tenant_id: string;
  attempts: number;
}

/**
 * Runs agents (ADR 0009). It claims runs from Postgres: queued ones (new, or with an approval just
 * decided) and running ones whose lease ran out because their worker died. Each invocation holds a
 * lease until it ends, waits for an approval, or is taken over, and writes its events to Valkey and
 * Postgres. Nothing calls a worker: it has no port.
 */
export function createWorker(opts: WorkerOptions) {
  const owner = opts.owner ?? `worker-${randomUUID().slice(0, 8)}`;
  const leaseMs = opts.leaseMs ?? 60_000;
  const concurrency = opts.concurrency ?? 10;
  const maxAttempts = opts.maxAttempts ?? 3;
  const agentIds = Object.keys(opts.agents);
  // A lease belongs to one invocation, not to the process: when a decision resumes a run, the
  // invocation that saved the wait (still finishing, maybe) can no longer write to it.
  const newLease = () => `${owner}/${randomUUID().slice(0, 8)}`;
  /** Invocations in progress, by lease. */
  const active = new Map<string, { tenantId: string; runId: string; ended: Promise<void> }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let pruning: ReturnType<typeof setInterval> | undefined;
  let polling: Promise<string[]> | undefined;
  let stopped = false;
  const report = (runId: string, err: unknown) => opts.onError?.(runId, err);

  /** Runs `sql` on the run while `lease` holds it. */
  const whileHeld = (
    tenantId: string,
    runId: string,
    lease: string,
    sql: string,
    args: unknown[] = [],
  ) =>
    withTenant(opts.pool, tenantId, (db) =>
      db.query(`${sql} where id = $1 and lease_owner = $2 and status = 'running'`, [
        runId,
        lease,
        ...args,
      ]),
    );

  const release = (tenantId: string, runId: string, lease: string) =>
    withTenant(opts.pool, tenantId, (db) =>
      db.query(
        "update runs set lease_owner = null, lease_until = null where id = $1 and lease_owner = $2",
        [runId, lease],
      ),
    );

  /** Ends a run that cannot go on, with a `run.failed` event so anyone following it sees it end. */
  const giveUp = async (tenantId: string, runId: string, lease: string, message: string) => {
    await appendEnding(opts.pool, opts.events, tenantId, runId, (seq, usage) => ({
      runId,
      seq,
      at: new Date().toISOString(),
      type: "run.failed",
      data: { reason: "error", message, usage },
    }));
    await release(tenantId, runId, lease);
  };

  /**
   * After a save was refused: if the run was cancelled while this invocation held it, writes
   * `run.cancelled` after everything the run wrote, once.
   */
  const endIfCancelled = async (tenantId: string, runId: string, lease: string) => {
    const { rows } = await withTenant(opts.pool, tenantId, (db) =>
      db.query<{
        status: string;
        lease_owner: string | null;
        cancelled_by: string | null;
        cancel_reason: string | null;
        ended: boolean;
      }>(
        `select status, lease_owner, cancelled_by, cancel_reason,
           exists (select 1 from run_events e where e.run_id = r.id and e.type = 'run.cancelled')
             as ended
         from runs r where id = $1`,
        [runId],
      ),
    );
    const run = rows[0];
    if (run?.status !== "cancelled" || run.lease_owner !== lease) return;
    if (!run.ended) {
      const by = run.cancelled_by ?? "unknown";
      await appendEnding(
        opts.pool,
        opts.events,
        tenantId,
        runId,
        cancelledEvent(runId, by, run.cancel_reason ?? undefined),
      );
    }
    await release(tenantId, runId, lease);
  };

  /** One invocation of a run, holding `lease` until it ends, waits or is taken over. */
  const launch = (
    lease: string,
    tenantId: string,
    runId: string,
    agent: AgentEntry,
    input: unknown,
    model: string | null,
    resume?: ResumeOptions,
  ) => {
    const heartbeat = setInterval(() => {
      const renew = `update runs set lease_until = now() + make_interval(secs => $3)`;
      void whileHeld(tenantId, runId, lease, renew, [leaseMs / 1000]).catch((err) =>
        report(runId, err),
      );
    }, leaseMs / 3);
    // async, so a throw before the run's own promise exists still ends here and stops the heartbeat
    const ended = (async () =>
      agent.run({
        tenantId,
        input: input as never,
        approver: later,
        runId,
        sinks: [opts.events.sink(), createPostgresEventSink(opts.pool, tenantId)],
        store: createPostgresRunStore(opts.pool, { owner: lease, leaseMs }),
        // a child saves through the same store and sinks, to a row of its own under this lease
        children: createChildRuns(opts.pool, opts.events, tenantId, lease),
        ...(model ? { model } : {}),
        ...(resume ? { resume } : {}),
      }))()
      .then(
        () => undefined,
        async (err: unknown) => {
          // the run was cancelled, or another worker holds it now; this invocation stops
          if (err instanceof RunInterrupted) {
            await endIfCancelled(tenantId, runId, lease).catch((e) => report(runId, e));
            return;
          }
          report(runId, err);
          // the lease runs out, and the run is claimed again until it has had its attempts
          const message = err instanceof Error ? err.message : String(err);
          await whileHeld(tenantId, runId, lease, "update runs set last_error = $3", [
            message,
          ]).catch((e) => report(runId, e));
        },
      )
      .finally(() => {
        clearInterval(heartbeat);
        active.delete(lease);
        // room for another run
        if (timer && !stopped) void worker.poll().catch((err) => report("poll", err));
      });
    active.set(lease, { tenantId, runId, ended });
  };

  /** Takes a claimed run over for one invocation, and starts or resumes it. */
  const takeOver = async ({ run_id: runId, tenant_id: tenantId, attempts }: Claimed) => {
    const lease = newLease();
    const run = await withTenant(opts.pool, tenantId, async (db) => {
      const { rows } = await db.query<{
        agent_id: string;
        input: unknown;
        decision: ApprovalDecision | null;
        last_error: string | null;
        saved: boolean;
        status: string;
        model: string | null;
      }>(
        `update runs r set lease_owner = $3
         where r.id = $1 and r.lease_owner = $2
         returning r.agent_id, r.input, r.decision, r.last_error, r.status, r.model,
           exists (select 1 from run_checkpoints where run_id = r.id) as saved`,
        [runId, owner, lease],
      );
      return rows[0];
    });
    if (!run) return;
    // cancelled while a worker that has since died held it: end it, never run it
    if (run.status === "cancelled") return endIfCancelled(tenantId, runId, lease);
    const agent = opts.agents[run.agent_id] as AgentEntry;
    if (attempts > maxAttempts) {
      const why = run.last_error ? `: ${run.last_error}` : "";
      return giveUp(tenantId, runId, lease, `gave up after ${maxAttempts} attempts${why}`);
    }
    if (!run.saved) {
      // Nothing saved: start afresh, unless it got as far as events, which can't be numbered again.
      if ((await lastSeq(opts.pool, opts.events, tenantId, runId)) > 0) {
        return giveUp(tenantId, runId, lease, "the run stopped before any of its state was saved");
      }
      // a host that skipped the input check: no attempt would get further, so fail it now
      const input = agent.input.safeParse(run.input);
      if (!input.success) {
        return giveUp(tenantId, runId, lease, `invalid input: ${z.prettifyError(input.error)}`);
      }
      return launch(lease, tenantId, runId, agent, run.input, run.model);
    }
    const [startSeq, events] = await Promise.all([
      lastSeq(opts.pool, opts.events, tenantId, runId),
      readStoredEvents(opts.pool, tenantId, runId, 0),
    ]);
    launch(lease, tenantId, runId, agent, run.input, run.model, {
      // a decision stays on the run until the first save after it, so a crash before then repeats it
      reason: run.decision ? "approval" : "recovery",
      startSeq,
      events,
      ...(run.decision ? { decision: run.decision } : {}),
    });
  };

  const worker = {
    owner,

    /** Claims what runs there is room for and starts them. Returns their ids. */
    poll(): Promise<string[]> {
      polling ??= (async () => {
        const room = concurrency - active.size;
        if (stopped || room <= 0) return [];
        const { rows } = await opts.pool.query<Claimed>(
          "select run_id, tenant_id, attempts from claim_runs($1, make_interval(secs => $2), $3, $4)",
          [owner, leaseMs / 1000, room, agentIds],
        );
        await Promise.all(rows.map((row) => takeOver(row).catch((err) => report(row.run_id, err))));
        return rows.map((r) => r.run_id);
      })().finally(() => {
        polling = undefined;
      });
      return polling;
    },

    /** Deletes save points older than `historyDays`, except each run's latest. Returns how many. */
    async prune(): Promise<number> {
      const { rows } = await opts.pool.query<{ pruned: number }>(
        "select prune_run_history(make_interval(days => $1)) as pruned",
        [opts.historyDays ?? 30],
      );
      return rows[0]?.pruned ?? 0;
    },

    /** Polls now and then every `pollMs`, and prunes old save points hourly, until `stop`. */
    start(pollMs = 1_000) {
      const tick = () => void worker.poll().catch((err) => report("poll", err));
      const prune = () => void worker.prune().catch((err) => report("prune", err));
      tick();
      prune();
      timer = setInterval(tick, pollMs);
      pruning = setInterval(prune, 60 * 60_000);
    },

    /**
     * Stops claiming, gives the runs in progress up to `graceMs` to end or wait, then hands the rest
     * to another worker at once rather than when their leases run out. A handed-over run resumes
     * from its last save; the hand-over doesn't count as an attempt.
     */
    async stop(graceMs = 20_000) {
      stopped = true;
      clearInterval(timer);
      clearInterval(pruning);
      await polling?.catch(() => undefined);
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        worker.idle(),
        new Promise((resolve) => {
          grace = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(grace);
      await Promise.all(
        [...active].map(([lease, { tenantId, runId }]) =>
          // a new owner, so this invocation's later saves fail; an expired lease, so it's claimable
          whileHeld(
            tenantId,
            runId,
            lease,
            `update runs set lease_owner = $3, lease_until = now(),
               attempts = greatest(attempts - 1, 0)`,
            [`${lease}/handed-over`],
          ).catch((err) => report(runId, err)),
        ),
      );
    },

    /** Waits for every invocation in progress; for tests and shutdown. */
    idle: async () => {
      await Promise.all([...active.values()].map((a) => a.ended));
    },

    /** Invocations in progress. */
    get running() {
      return active.size;
    },
  };
  return worker;
}

export type Worker = ReturnType<typeof createWorker>;
