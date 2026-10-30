import { type RunEvent, RunUsage } from "@dugout/contracts";
import { type Pool, withTenant } from "@dugout/db";
import { createPostgresEventSink, type ValkeyEventLog } from "./event-log.ts";

/** Usage of a run that never got as far as saving any. */
export const NO_USAGE: RunUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  budgetCostUsd: 0,
  steps: 0,
};

/** The last `seq` a run's events reached, live stream (tokens) or permanent record. */
export async function lastSeq(pool: Pool, events: ValkeyEventLog, tenantId: string, runId: string) {
  const stored = await withTenant(pool, tenantId, (db) =>
    db.query<{ seq: number }>(
      "select coalesce(max(seq), 0) as seq from run_events where run_id = $1",
      [runId],
    ),
  );
  return Math.max(stored.rows[0]?.seq ?? 0, await events.lastSeq(runId));
}

/** What the run had spent when it last saved its state, if it has. */
export async function savedUsage(
  pool: Pool,
  tenantId: string,
  runId: string,
): Promise<RunUsage | undefined> {
  const { rows } = await withTenant(pool, tenantId, (db) =>
    db.query<{ usage: unknown }>(
      "select checkpoint -> 'usage' as usage from run_checkpoints where run_id = $1",
      [runId],
    ),
  );
  return rows[0] ? RunUsage.parse(rows[0].usage) : undefined;
}

/**
 * Appends a run's last event after everything it wrote, to the live stream and the permanent
 * record (which sets the run's final status). `make` gets the event's `seq` and the usage the run
 * had saved.
 */
export async function appendEnding(
  pool: Pool,
  events: ValkeyEventLog,
  tenantId: string,
  runId: string,
  make: (seq: number, usage: RunUsage) => RunEvent,
): Promise<RunEvent> {
  const [seq, usage] = await Promise.all([
    lastSeq(pool, events, tenantId, runId),
    savedUsage(pool, tenantId, runId),
  ]);
  const event = make(seq + 1, usage ?? NO_USAGE);
  await events.sink().write(event);
  await createPostgresEventSink(pool, tenantId).write(event);
  return event;
}

/** The `run.cancelled` event, for `appendEnding`. */
export const cancelledEvent =
  (runId: string, by: string, reason?: string) =>
  (seq: number, usage: RunUsage): RunEvent => ({
    runId,
    seq,
    at: new Date().toISOString(),
    type: "run.cancelled",
    data: { by, ...(reason ? { reason } : {}), usage },
  });
