import type {
  AssistantMessage,
  Message,
  ModelClient,
  ModelRequest,
  ModelTurn,
  ToolCall,
  ToolInputDelta,
} from "@dugout/contracts";
import OpenAI from "openai";

// Wire types come from the SDK and stay inside this file.
type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type WireMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type WireUsage = OpenAI.Completions.CompletionUsage & { prompt_cache_hit_tokens?: number };

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey: string;
  replayReasoning: boolean;
  /** Applies to HTTP errors (the SDK retries 408/409/429/5xx) and to retryable finish reasons. */
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// DeepSeek ends a stream with these when it drops a request under load.
const RETRYABLE_FINISH = new Set(["insufficient_system_resource", "aborted"]);

/** Chat Completions over the official `openai` SDK; works with any compatible provider (ADR 0001). */
export function createOpenAICompatibleClient(opts: OpenAICompatibleOptions): ModelClient {
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const client = new OpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    maxRetries,
    timeout: opts.timeoutMs ?? 600_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    async complete(req, onToken, onToolInput) {
      for (let attempt = 0; ; attempt++) {
        const turn = await streamTurn(client, req, opts.replayReasoning, onToken, onToolInput);
        if (!RETRYABLE_FINISH.has(turn.finishReason)) return turn;
        if (attempt >= maxRetries) {
          throw new Error(
            `model call ended with ${turn.finishReason} after ${attempt + 1} attempts`,
          );
        }
        await sleep(500 * 2 ** attempt);
      }
    },
  };
}

async function streamTurn(
  client: OpenAI,
  req: ModelRequest,
  replayReasoning: boolean,
  onToken?: (text: string) => void,
  onToolInput?: (delta: ToolInputDelta) => void,
): Promise<ModelTurn> {
  const body = {
    model: req.model,
    messages: req.messages.map((m) => toWire(m, replayReasoning)),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: encodeName(t.name),
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }
      : {}),
    ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    ...req.extraBody,
  } as CreateParams;
  const stream = await client.chat.completions.create(
    body,
    req.signal ? { signal: req.signal } : undefined,
  );

  let content = "";
  let reasoning = "";
  let finishReason = "";
  let model = req.model;
  let fingerprint: string | undefined;
  let usage: WireUsage | undefined;
  const calls: ToolCall[] = [];

  for await (const chunk of stream) {
    model = chunk.model || model;
    fingerprint = chunk.system_fingerprint ?? fingerprint;
    // DeepSeek puts usage on the last content chunk; OpenAI sends a separate chunk with no choices.
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta as typeof choice.delta & { reasoning_content?: string | null };
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (delta.content) {
      content += delta.content;
      onToken?.(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      calls[part.index] ??= { id: "", name: "", arguments: "" };
      const call = calls[part.index] as ToolCall;
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name = decodeName(part.function.name);
      if (part.function?.arguments) {
        call.arguments += part.function.arguments;
        onToolInput?.({
          index: part.index,
          callId: call.id,
          tool: call.name,
          text: part.function.arguments,
        });
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls = calls.filter(Boolean);
  const message: AssistantMessage = {
    role: "assistant",
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return {
    message,
    tokens: {
      inputTokens: usage?.prompt_tokens ?? 0,
      cachedInputTokens:
        usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    servedModel: fingerprint ? `${model} (${fingerprint})` : model,
    finishReason,
  };
}

function toWire(message: Message, replayReasoning: boolean): WireMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || (message.toolCalls ? null : ""),
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: encodeName(call.name), arguments: call.arguments },
              })),
            }
          : {}),
        ...(replayReasoning && message.reasoning !== undefined
          ? { reasoning_content: message.reasoning }
          : {}),
      } as WireMessage;
  }
}

// Function names must match ^[a-zA-Z0-9_-]+$. Tool names are dotted and never contain `_`.
export const encodeName = (name: string) => name.replaceAll(".", "__");
export const decodeName = (name: string) => name.replaceAll("__", ".");
