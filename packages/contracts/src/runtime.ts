import type { RunEvent } from "./events.ts";
import type { Message, ToolCall } from "./messages.ts";
import type { ModelTier, ModelTurn, StepUsage, ToolDefinition } from "./model.ts";
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
  tier: ModelTier;
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

/**
 * Everything the loop does that touches the outside world. In-process it calls functions directly;
 * under Temporal each method becomes an activity (model, tool) or a signal wait (approval).
 */
export interface Steps {
  model(req: ModelStepRequest): Promise<ModelStep>;
  tool(req: ToolStepRequest): Promise<ToolOutcome>;
  approval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Adapter for agents whose loop is not ours (e.g. LangGraph). Not used by the core loop. */
export interface AgentRuntime {
  run(input: unknown, ctx: RunContext): AsyncIterable<RunEvent>;
}
