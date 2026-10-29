import type { ModelClient, ModelRequest, TokenUsage } from "@dugout/contracts";
import type { ModelConfig } from "./config.ts";

export interface ScriptedTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  tokens?: Partial<TokenUsage>;
  finishReason?: string;
}

export type ScriptStep = ScriptedTurn | ((req: ModelRequest) => ScriptedTurn);

/** A `ModelClient` that replays a fixed script, for tests and offline eval smoke runs. */
export function createScriptedModel(script: ScriptStep[]): ModelClient & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async complete(req, onToken) {
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
          typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      }));
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

/** Config for the scripted model: $1 per 1M tokens of any kind, at a constant rate. */
export function scriptedModelConfig(): ModelConfig {
  const price = { inputCacheHit: 1, inputCacheMiss: 1, output: 1 };
  return {
    baseURL: "scripted://",
    apiKey: "scripted",
    replayReasoning: true,
    tiers: {
      fast: { model: "scripted-fast", contextWindow: 100_000 },
      smart: { model: "scripted-smart", contextWindow: 100_000 },
    },
    pricing: { prices: { "scripted-fast": price, "scripted-smart": price }, rateAt: () => 1 },
  };
}
