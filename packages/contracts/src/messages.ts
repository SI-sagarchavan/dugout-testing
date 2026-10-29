import { z } from "zod";

// Transcript messages are shaped like OpenAI Chat Completions (ADR 0001), but they are our types:
// no provider SDK type crosses the contracts.

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(), // JSON text, exactly as the model produced it
});
export type ToolCall = z.infer<typeof ToolCall>;

export const SystemMessage = z.object({ role: z.literal("system"), content: z.string() });
export const UserMessage = z.object({ role: z.literal("user"), content: z.string() });
export const AssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  reasoning: z.string().optional(), // thinking output; some providers require it replayed
  toolCalls: z.array(ToolCall).optional(),
});
export const ToolMessage = z.object({
  role: z.literal("tool"),
  toolCallId: z.string(),
  content: z.string(),
});

export const Message = z.discriminatedUnion("role", [
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
]);
export type Message = z.infer<typeof Message>;
export type AssistantMessage = z.infer<typeof AssistantMessage>;
export type ToolMessage = z.infer<typeof ToolMessage>;
