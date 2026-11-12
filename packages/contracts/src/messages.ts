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
/**
 * A block of reasoning as the model signed it: the text with its signature, or content the
 * provider encrypted (base64). Sent back to the model unchanged on later turns.
 */
export const ReasoningBlock = z.union([
  z.object({ text: z.string(), signature: z.string() }),
  z.object({ redacted: z.string() }),
]);
export type ReasoningBlock = z.infer<typeof ReasoningBlock>;

export const AssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  reasoning: z.string().optional(), // thinking text, for people to read
  reasoningBlocks: z.array(ReasoningBlock).optional(), // what the model gets back, when it signs
  toolCalls: z.array(ToolCall).optional(),
});
export const ToolMessage = z.object({
  role: z.literal("tool"),
  toolCallId: z.string(),
  content: z.string(),
  /** The call failed, was refused or was not run; the provider is told, where it takes it. */
  isError: z.boolean().optional(),
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

/** One tool call of a transcript, with the result it got. */
export interface AnsweredCall {
  /** Where its result is in the transcript. */
  at: number;
  id: string;
  name: string;
  /** Its arguments, parsed; undefined when they are not JSON. */
  args: unknown;
  /** Its result as the model read it: a long one is only its reference. */
  content: string;
  isError: boolean;
}

/**
 * The calls of a transcript that were answered, in the order their results came, to `name` when
 * one is given (or any of several). For what the run did with tools that are not the agent's own
 * (a server's, a child agent, `ask`). What an agent's own tool made is kept in the run's state
 * (`ToolContext.state`, ADR 0035), not read back from here.
 */
export function answeredCalls(
  messages: readonly Message[],
  name?: string | readonly string[],
): AnsweredCall[] {
  const wanted = name === undefined ? undefined : new Set(typeof name === "string" ? [name] : name);
  const calls = new Map<string, ToolCall>();
  const found: AnsweredCall[] = [];
  for (const [at, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (!wanted || wanted.has(call.name)) calls.set(call.id, call);
      }
    } else if (message.role === "tool") {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        // left undefined: the call's result still says what happened
      }
      found.push({
        at,
        id: call.id,
        name: call.name,
        args,
        content: message.content,
        isError: Boolean(message.isError),
      });
    }
  }
  return found;
}
