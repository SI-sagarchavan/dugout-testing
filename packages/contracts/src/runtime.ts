import { z } from "zod";
import { type RunEvent, RunUsage } from "./events.ts";
import type { Message, ToolCall } from "./messages.ts";
import type { ModelTurn, StepUsage, ToolDefinition } from "./model.ts";
import type { ToolOutcome } from "./tools.ts";

/** Verified identity for one run. Built by the caller (CLI now, API later), never by the model. */
export interface RunContext {
  readonly runId: string;
  readonly tenantId: string;
  /** The host's parsed run input. Tools may read it. The model cannot change it. */
  readonly input?: unknown;
}

/** Memory and skills assembled for a run, appended to the agent's instructions. */
export interface RunMemoryContext {
  text: string;
  tokens: number;
  sources: Array<{ id: string; kind: string; tokens: number; text?: string }>;
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

/** What a save point comes right after. Every one is kept, so a run can be forked from it. */
export const SavedAfter = z.enum([
  "start", // the run's instructions and input
  "model", // a model turn
  "call", // a call about to run
  "tool", // a call's result, or why it didn't run
  "waiting", // an approval asked for
  "decision", // a reviewer's decision
  "end", // the run's last save
  "fork", // a fork's copy of its parent's save point
]);
export type SavedAfter = z.infer<typeof SavedAfter>;

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
  /** Unset on checkpoints saved before save points were kept. */
  savedAfter: SavedAfter.optional(),
  /** The run and save point this run was forked from. */
  forkedFrom: z.object({ runId: z.string(), version: z.number().int().positive() }).optional(),
});
export type RunCheckpoint = z.infer<typeof RunCheckpoint>;

/** A run's working memory as saved: its checkpoint and its transcript. */
export interface SavedRun {
  checkpoint: RunCheckpoint;
  messages: Message[];
}

/** One save point of a run, as its history lists it. */
export interface SavePoint {
  /** 1 for the run's first save, counting up. */
  version: number;
  step: number;
  savedAfter: SavedAfter | undefined;
  /** Transcript messages at this point. */
  messages: number;
  /** The call it waited for a decision on, if it did. */
  waiting?: { callId: string; tool: string };
  savedAt: string;
}

/**
 * Keeps runs' working memory between invocations. The transcript only grows, so any save point's
 * transcript is the first `checkpoint.messages` of it.
 */
export interface RunStore {
  /** The latest save point, or the one `version` names. */
  load(ctx: RunContext, version?: number): Promise<SavedRun | undefined>;
  /** Appends `messages` to the transcript and saves the checkpoint as a new save point, in one write. */
  save(ctx: RunContext, checkpoint: RunCheckpoint, messages: Message[]): Promise<void>;
  /** Every save point kept, oldest first. */
  history(ctx: RunContext): Promise<SavePoint[]>;
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
