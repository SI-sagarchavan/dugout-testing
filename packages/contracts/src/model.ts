import { z } from "zod";
import type { AssistantMessage, Message } from "./messages.ts";

/** How hard a model thinks before it answers; which levels a model takes depends on its family. */
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

/** A tool as the model sees it: name, description and a JSON schema for its arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TokenUsage = z.object({
  inputTokens: z.number(), // includes cache reads and writes
  cachedInputTokens: z.number(), // read from the prompt cache
  cacheWriteInputTokens: z.number().default(0), // written to the prompt cache
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
  /** A name in the model list (`config/models.json`); the client sends its id, effort and limits. */
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** The model must call this tool, and no other. Sent only to a model whose entry has `forcedTools`. */
  toolChoice?: { tool: string };
  /** Mark the prompt for the provider's cache, for a conversation that goes on for more turns. */
  cache?: boolean;
  signal?: AbortSignal;
}

export interface ModelTurn {
  message: AssistantMessage;
  tokens: TokenUsage;
  /** The provider's id for the model that answered, which can differ from the requested one. */
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
