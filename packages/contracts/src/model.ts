import { z } from "zod";
import type { AssistantMessage, Message } from "./messages.ts";

export const ModelTier = z.enum(["fast", "smart"]);
export type ModelTier = z.infer<typeof ModelTier>;

/** A tool as the model sees it: name, description and a JSON schema for its arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TokenUsage = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(), // includes reasoning tokens
  reasoningTokens: z.number(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const StepUsage = TokenUsage.extend({
  costUsd: z.number(), // at the actual rate for the time of the call
  budgetCostUsd: z.number(), // at list (peak) rate; what budgets are enforced on
});
export type StepUsage = z.infer<typeof StepUsage>;

export interface ModelRequest {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelTurn {
  message: AssistantMessage;
  tokens: TokenUsage;
  /** Model and fingerprint the provider reports, which can differ from the requested id. */
  servedModel: string;
  finishReason: string;
}

/** A fragment of a tool call's arguments (JSON text) as the model writes them. */
export interface ToolInputDelta {
  /** Position of the call in the turn. */
  index: number;
  callId: string;
  tool: string;
  text: string;
}

/**
 * One adapter per wire protocol. `onToken` receives visible content only, never reasoning;
 * `onToolInput` receives tool-call arguments as they stream (not valid JSON until the call ends).
 */
export interface ModelClient {
  complete(
    req: ModelRequest,
    onToken?: (text: string) => void,
    onToolInput?: (delta: ToolInputDelta) => void,
  ): Promise<ModelTurn>;
}
