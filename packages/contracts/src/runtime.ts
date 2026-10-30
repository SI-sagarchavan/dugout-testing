import { z } from "zod";
import { type RunEvent, RunUsage } from "./events.ts";
import type { Message, ToolCall } from "./messages.ts";
import type { ModelTurn, StepUsage, ToolDefinition } from "./model.ts";
import type { ToolOutcome } from "./tools.ts";

/** Verified identity for one run. Built by the caller (CLI now, API later), never by the model. */
export interface RunContext {
  readonly runId: string;
  readonly tenantId: string;
}

/** Memory and skills assembled for a run, appended to the agent's instructions. */
export interface RunMemoryContext {
  text: string;
  tokens: number;
  sources: Array<{ id: string; kind: string; tokens: number }>;
}

export interface ModelStepRequest {
  step: number;
  /** A name in the model list. */
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
}

export type ModelStep = ModelTurn & { usage: StepUsage };

export interface ToolStepRequest {
  step: number;
  call: ToolCall;
  /** Already parsed and validated by preflight. */
  input: unknown;
}

export interface ApprovalRequest {
  step: number;
  call: ToolCall;
  tool: string;
  input: unknown;
}

/**
 * `reason` rejects the call and ends the run. `changes` sends the reviewer's request back to the
 * model in the same run, which keeps its transcript and calls the tool again.
 */
export type ApprovalDecision =
  | { approved: true; by: string }
  | { approved: false; by: string; reason: string }
  | { approved: false; by: string; changes: string };

/** No decision yet: the run saves its state and ends, and the decision resumes it later. */
export interface ApprovalPending {
  pending: true;
}

/**
 * Where a run is, saved after every change so a later invocation (after an approval, or after a
 * crash) carries on from here. The transcript is saved beside it, append-only.
 */
export const RunCheckpoint = z.object({
  version: z.literal(1),
  agentId: z.string(),
  agentVersion: z.number(),
  /** Model turns taken so far. */
  step: z.number().int().nonnegative(),
  usage: RunUsage,
  /** Transcript messages saved so far. */
  messages: z.number().int().nonnegative(),
  /** `seq` of the last event emitted before this was saved. */
  lastSeq: z.number().int().nonnegative(),
  invalidOutputs: z.number().int().nonnegative(),
  blockedFinishes: z.number().int().nonnegative(),
  /** Change requests not yet approved, by tool. */
  pendingChanges: z.record(z.string(), z.string()),
  /** Set while the calls of the last assistant message are being answered. */
  turn: z
    .object({
      changesRequested: z.boolean(),
      remind: z.boolean(),
      /** Calls the reviewer approved, so a resumed run does not ask again. */
      approved: z.array(z.string()),
      /** Calls whose tool started; after a crash only retry-safe tools run again. */
      started: z.array(z.string()),
    })
    .optional(),
  /** The approval the run is waiting for. */
  waiting: z
    .object({ step: z.number(), callId: z.string(), tool: z.string(), input: z.unknown() })
    .optional(),
});
export type RunCheckpoint = z.infer<typeof RunCheckpoint>;

/** A run's working memory as saved: its checkpoint and its transcript. */
export interface SavedRun {
  checkpoint: RunCheckpoint;
  messages: Message[];
}

/** Keeps runs' working memory between invocations. */
export interface RunStore {
  load(ctx: RunContext): Promise<SavedRun | undefined>;
  /** Appends `messages` to the transcript and replaces the checkpoint, in one write. */
  save(ctx: RunContext, checkpoint: RunCheckpoint, messages: Message[]): Promise<void>;
}

/**
 * Everything the loop does that touches the outside world. In-process it calls functions directly;
 * under Temporal each method becomes an activity (model, tool) or a signal wait (approval).
 */
export interface Steps {
  model(req: ModelStepRequest): Promise<ModelStep>;
  tool(req: ToolStepRequest): Promise<ToolOutcome>;
  approval(req: ApprovalRequest): Promise<ApprovalDecision | ApprovalPending>;
  /** Saves the run's state; without it the run cannot outlive this invocation. */
  checkpoint?(checkpoint: RunCheckpoint, appended: Message[]): Promise<void>;
}

/** Adapter for agents whose loop is not ours (e.g. LangGraph). Not used by the core loop. */
export interface AgentRuntime {
  run(input: unknown, ctx: RunContext): AsyncIterable<RunEvent>;
}
