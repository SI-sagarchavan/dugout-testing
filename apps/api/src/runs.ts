import { randomUUID } from "node:crypto";
import type { ApprovalDecision, EventSink } from "@dugout/contracts";
import type { Approver } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import type { z } from "zod";
import { createPostgresEventSink, type ValkeyEventLog } from "./event-log.ts";

/** How the API starts one kind of agent. */
export interface AgentEntry {
  input: z.ZodType;
  run(opts: {
    tenantId: string;
    input: never;
    approver: Approver;
    runId: string;
    sinks: EventSink[];
  }): Promise<unknown>;
}

interface Pending {
  tenantId: string;
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * Starts runs in this process and holds their approval waits. Without Temporal, a run lives as
 * long as the API process: a restart loses runs in flight (they stay `running` in Postgres).
 */
export function createRunManager(opts: {
  pool: Pool;
  events: ValkeyEventLog;
  agents: Record<string, AgentEntry>;
  onError?: (runId: string, err: unknown) => void;
}) {
  const pending = new Map<string, Pending>();
  const inFlight = new Set<Promise<unknown>>();
  const key = (runId: string, callId: string) => `${runId}/${callId}`;

  return {
    agentIds: () => Object.keys(opts.agents),

    async start(tenantId: string, agentId: string, rawInput: unknown) {
      const agent = opts.agents[agentId];
      if (!agent) throw new RunError(404, `unknown agent ${agentId}`);
      const parsed = agent.input.safeParse(rawInput);
      if (!parsed.success) throw new RunError(400, `invalid input: ${parsed.error.message}`);

      const runId = randomUUID();
      await withTenant(opts.pool, tenantId, (db) =>
        db.query(
          "insert into runs (id, tenant_id, agent_id, status, input) values ($1, $2, $3, 'running', $4)",
          [runId, tenantId, agentId, parsed.data],
        ),
      );
      const approver: Approver = (req) =>
        new Promise((resolve) => pending.set(key(runId, req.call.id), { tenantId, resolve }));
      const run = agent
        .run({
          tenantId,
          input: parsed.data as never,
          approver,
          runId,
          sinks: [opts.events.sink(), createPostgresEventSink(opts.pool, tenantId)],
        })
        .catch((err) => opts.onError?.(runId, err))
        .finally(() => inFlight.delete(run));
      inFlight.add(run);
      return runId;
    },

    /** Resolves a waiting approval. False when there is none for this tenant, run and call. */
    decide(tenantId: string, runId: string, callId: string, decision: ApprovalDecision) {
      const waiting = pending.get(key(runId, callId));
      if (!waiting || waiting.tenantId !== tenantId) return false;
      pending.delete(key(runId, callId));
      waiting.resolve(decision);
      return true;
    },

    /** Waits for every run started so far; for tests and graceful shutdown. */
    idle: () => Promise.all([...inFlight]),
  };
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
