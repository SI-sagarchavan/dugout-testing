import type { ModelClient, ModelRequest } from "@dugout/contracts";

/**
 * Code that takes an agent's turn in place of its model: the tool calls the turn makes. Undefined
 * leaves the turn to the model. A throw ends the run, failed, with the error's message. It is how
 * a workflow's own turns cost no model call: its steps are known, so nothing is decided there.
 */
export type Driver = (
  req: ModelRequest,
) => Array<{ name: string; arguments?: Record<string, unknown> }> | undefined;

/** What `servedModel` says of a turn code took. */
export const CODE_TURN = "code";

/** `client`, with `driver` asked first for each turn. A turn it takes spends no tokens. */
export function drivenClient(client: ModelClient, driver: Driver): ModelClient {
  return {
    async complete(req, onToken, onToolInput) {
      const calls = driver(req);
      if (!calls) return client.complete(req, onToken, onToolInput);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: calls.map((call, i) => ({
            // the transcript only grows, so its length names the turn
            id: `code_${req.messages.length}_${i}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          })),
        },
        tokens: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        servedModel: CODE_TURN,
        finishReason: "tool_calls",
      };
    },
  };
}
