import { type Pool, withTenant } from "@dugout/db";
import type { ChildRuns } from "@dugout/sdk";
import type { ValkeyEventLog } from "./event-log.ts";
import { lastSeq } from "./records.ts";

/**
 * Child runs' records (ADR 0025): each child a `runs` row of its own, linked to the run and call
 * that started it, held by the parent's lease. Claims skip it (`parent_call_id`, migration 012):
 * it runs inside its parent's call, and a resumed parent starts it again from its save.
 */
export function createChildRuns(
  pool: Pool,
  events: ValkeyEventLog,
  tenantId: string,
  lease: string,
): ChildRuns {
  return {
    async open({ runId, agentId, input, parent }) {
      await withTenant(pool, tenantId, (db) =>
        db.query(
          `insert into runs (id, tenant_id, agent_id, status, input, parent_run_id, parent_call_id,
             lease_owner)
           values ($1, $2, $3, 'running', $4, $5, $6, $7)
           on conflict (id) do update set lease_owner = excluded.lease_owner, updated_at = now()
           where runs.parent_call_id = excluded.parent_call_id`,
          [runId, tenantId, agentId, JSON.stringify(input), parent.runId, parent.callId, lease],
        ),
      );
      return { lastSeq: await lastSeq(pool, events, tenantId, runId) };
    },
  };
}
