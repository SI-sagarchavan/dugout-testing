import {
  type Message,
  RunCheckpoint,
  type RunContext,
  type RunStore,
  type SavedRun,
  type SavePoint,
} from "@dugout/contracts";
import { RunInterrupted, savePoint } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";

/** A run's latest save point, or the one `version` names, with its transcript up to then. */
export const loadRun = (pool: Pool, { tenantId, runId }: RunContext, version?: number) =>
  withTenant(pool, tenantId, async (db): Promise<SavedRun | undefined> => {
    const { rows } = await db.query<{ checkpoint: unknown }>(
      version === undefined
        ? "select checkpoint from run_checkpoints where run_id = $1"
        : "select checkpoint from run_checkpoint_history where run_id = $1 and version = $2",
      version === undefined ? [runId] : [runId, version],
    );
    if (!rows[0]) return undefined;
    const checkpoint = RunCheckpoint.parse(rows[0].checkpoint);
    const messages = await db.query<{ message: Message }>(
      "select message from run_messages where run_id = $1 and idx < $2 order by idx",
      [runId, checkpoint.messages],
    );
    return { checkpoint, messages: messages.rows.map((r) => r.message) };
  });

/** Every save point of a run still kept, oldest first. */
export const runHistory = (pool: Pool, { tenantId, runId }: RunContext) =>
  withTenant(pool, tenantId, async (db): Promise<SavePoint[]> => {
    const { rows } = await db.query<{ version: number; checkpoint: unknown; saved_at: Date }>(
      `select version, checkpoint, saved_at from run_checkpoint_history where run_id = $1
       order by version`,
      [runId],
    );
    return rows.map((r) =>
      savePoint(r.version, RunCheckpoint.parse(r.checkpoint), r.saved_at.toISOString()),
    );
  });

/**
 * Runs' working memory in Postgres (ADR 0006): the transcript in `run_messages`, append-only, the
 * latest checkpoint in `run_checkpoints` and every one in `run_checkpoint_history`, written together
 * in one transaction.
 *
 * Every save is fenced by the run's lease. It renews the lease only when `owner` still holds it,
 * and otherwise throws `RunInterrupted` before writing anything, so a process that lost a run (it
 * stalled, and another process picked the run up) can never overwrite the new owner's state. A save
 * also clears the approval decision the run was queued with: once saved, the checkpoint holds it.
 */
export function createPostgresRunStore(
  pool: Pool,
  opts: { owner: string; leaseMs: number },
): RunStore {
  return {
    load: (ctx: RunContext, version?: number) => loadRun(pool, ctx, version),

    history: (ctx: RunContext) => runHistory(pool, ctx),

    save: ({ tenantId, runId }: RunContext, checkpoint: RunCheckpoint, appended: Message[]) =>
      withTenant(pool, tenantId, async (db) => {
        const waiting = checkpoint.waiting !== undefined;
        const lease = await db.query(
          `update runs
           set status = $3, decision = null,
               lease_until = case when $4 then null else now() + make_interval(secs => $5) end,
               updated_at = now()
           where id = $1 and lease_owner = $2 and status in ('running', 'waiting')`,
          [runId, opts.owner, waiting ? "waiting" : "running", waiting, opts.leaseMs / 1000],
        );
        if (lease.rowCount === 0)
          throw new RunInterrupted(`${opts.owner} no longer holds run ${runId}`);
        const first = checkpoint.messages - appended.length;
        for (const [i, message] of appended.entries()) {
          await db.query(
            "insert into run_messages (run_id, idx, tenant_id, message) values ($1, $2, $3, $4)",
            [runId, first + i, tenantId, JSON.stringify(message)],
          );
        }
        const saved = await db.query<{ version: number }>(
          `insert into run_checkpoints (run_id, tenant_id, checkpoint, version) values ($1, $2, $3, 1)
           on conflict (run_id) do update
           set checkpoint = excluded.checkpoint, version = run_checkpoints.version + 1,
               updated_at = now()
           returning version`,
          [runId, tenantId, JSON.stringify(checkpoint)],
        );
        await db.query(
          `insert into run_checkpoint_history (run_id, version, tenant_id, checkpoint)
           values ($1, $2, $3, $4)`,
          [runId, saved.rows[0]?.version, tenantId, JSON.stringify(checkpoint)],
        );
      }),
  };
}
