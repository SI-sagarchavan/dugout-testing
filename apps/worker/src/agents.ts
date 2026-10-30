import type { ApprovalDecision, EventSink, RunEvent, RunStore } from "@dugout/contracts";
import type { Approver, RunResult } from "@dugout/core";
import type { AgentDeps, AnyAgent } from "@dugout/sdk";
import type { z } from "zod";

/** How a run is carried on from its saved state. */
export interface ResumeOptions {
  reason: "approval" | "recovery";
  decision?: ApprovalDecision;
  /** The last `seq` the event log already has. */
  startSeq: number;
  /** The run's earlier events, for memory consolidation at the end. */
  events: RunEvent[];
}

/** How a worker starts (or resumes) one kind of agent. */
export interface AgentEntry {
  /** What a run's input must look like; a queued run whose input doesn't fails at once. */
  input: z.ZodType;
  run(opts: {
    tenantId: string;
    input: never;
    approver: Approver;
    runId: string;
    sinks: EventSink[];
    store: RunStore;
    resume?: ResumeOptions;
  }): Promise<RunResult>;
}

/** Worker entries for agents made with `defineAgent`, by id, all run with the same deps. */
export function hostAgents(deps: AgentDeps, ...agents: AnyAgent[]): Record<string, AgentEntry> {
  return Object.fromEntries(
    agents.map((agent) => [agent.spec.id, { input: agent.input, run: agent.create(deps) }]),
  );
}
