import type { ModelClient, ModelRequest, TokenUsage } from "@dugout/contracts";
import { loadModelConfig, type ModelConfig } from "./config.ts";

export interface ScriptedTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  tokens?: Partial<TokenUsage>;
  finishReason?: string;
}

export type ScriptStep = ScriptedTurn | ((req: ModelRequest) => ScriptedTurn);

/**
 * A write that waits for a yes carries a required `reason` (what it does and why). A script that
 * does not write one gets a stand-in, so the same script serves a tool whether or not it writes;
 * a script that does keeps its own.
 */
function withReason(
  call: { name: string; arguments: unknown },
  tools: ModelRequest["tools"],
): unknown {
  const args = call.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args) || "reason" in args) {
    return args;
  }
  const parameters = tools?.find((t) => t.name === call.name)?.parameters as
    | { required?: string[] }
    | undefined;
  return parameters?.required?.includes("reason")
    ? { ...args, reason: `scripted: ${call.name}` }
    : args;
}

/** A `ModelClient` that replays a fixed script, for tests and offline eval smoke runs. */
export function createScriptedModel(script: ScriptStep[]): ModelClient & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async complete(req, onToken, onToolInput) {
      const { signal: _, ...rest } = req;
      requests.push(structuredClone(rest));
      const step = script[requests.length - 1];
      if (!step) throw new Error(`script exhausted after ${script.length} turns`);
      const turn = typeof step === "function" ? step(req) : step;
      if (turn.content) onToken?.(turn.content);
      const toolCalls = turn.toolCalls?.map((call, i) => ({
        id: `call_${requests.length}_${i}`,
        name: call.name,
        arguments:
          typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(withReason(call, req.tools)),
      }));
      // the whole arguments as one fragment; a real model sends many
      for (const [index, call] of (toolCalls ?? []).entries()) {
        onToolInput?.({ index, callId: call.id, tool: call.name, text: call.arguments });
      }
      return {
        message: {
          role: "assistant",
          content: turn.content ?? "",
          ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
          ...(toolCalls ? { toolCalls } : {}),
        },
        tokens: {
          inputTokens: 1_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 200,
          reasoningTokens: 0,
          ...turn.tokens,
        },
        servedModel: req.model,
        finishReason: turn.finishReason ?? (toolCalls ? "tool_calls" : "stop"),
      };
    },
  };
}

/**
 * Config for the scripted model: every name in the model list, so any spec runs against the
 * script, each at $1 per 1M tokens of any kind and with a 100K context window.
 */
export function scriptedModelConfig(): ModelConfig {
  const price = { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 };
  const models = Object.entries(loadModelConfig().models).map(([name, model]) => [
    name,
    { ...model, contextWindow: 100_000, price },
  ]);
  return { models: Object.fromEntries(models) };
}
