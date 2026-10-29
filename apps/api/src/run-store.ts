import { type Message, RunCheckpoint, type RunContext, type RunStore } from "@dugout/contracts";
import { RunInterrupted } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";

/**
 * Runs' working memory in Postgres (ADR 0006): the transcript in `run_messages`, append-only, and
 * the checkpoint in `run_checkpoints`, written together in one transaction.
 *
 * Every save is fenced by the run's lease. It renews the lease only when `owner` still holds it,
 * and otherwise throws `RunInterrupted` before writing anything, so a process that lost a run (it
 * stalled, and another process picked the run up) can never overwrite the new owner's state.
 */
export function createPostgresRunStore(
  pool: Pool,
  opts: { owner: string; leaseMs: number },
): RunStore {
  return {
    load: ({ tenantId, runId }: RunContext) =>
      withTenant(pool, tenantId, async (db) => {
        const { rows } = await db.query<{ checkpoint: unknown }>(
          "select checkpoint from run_checkpoints where run_id = $1",
          [runId],
        );
        if (!rows[0]) return undefined;
        const checkpoint = RunCheckpoint.parse(rows[0].checkpoint);
        const messages = await db.query<{ message: Message }>(
          "select message from run_messages where run_id = $1 and idx < $2 order by idx",
          [runId, checkpoint.messages],
        );
        return { checkpoint, messages: messages.rows.map((r) => r.message) };
      }),

    save: ({ tenantId, runId }: RunContext, checkpoint: RunCheckpoint, appended: Message[]) =>
      withTenant(pool, tenantId, async (db) => {
        const waiting = checkpoint.waiting !== undefined;
        const lease = await db.query(
          `update runs
           set status = $3,
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
        await db.query(
          `insert into run_checkpoints (run_id, tenant_id, checkpoint) values ($1, $2, $3)
           on conflict (run_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`,
          [runId, tenantId, JSON.stringify(checkpoint)],
        );
      }),
  };
}
