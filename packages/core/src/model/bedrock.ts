import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type ToolInputSchema,
  type Message as WireMessage,
  type TokenUsage as WireUsage,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  AssistantMessage,
  ModelClient,
  ModelRequest,
  ModelTurn,
  ToolCall,
  ToolInputDelta,
} from "@dugout/contracts";

// Wire types come from the SDK and stay inside this file.
type Document = NonNullable<ToolInputSchema.JsonMember["json"]>;

// Tool names must match ^[a-zA-Z0-9_-]+$. Ours are dotted and never contain `_`.
const encodeName = (name: string) => name.replaceAll(".", "__");
const decodeName = (name: string) => name.replaceAll("__", ".");

/** Sends a command and returns its output: the SDK client, or a fake in tests. */
export interface BedrockRuntime {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface BedrockClientOptions {
  /** Defaults to `bedrockRegion()`. */
  region?: string;
  runtime?: BedrockRuntime;
}

const FALLBACK_REGION = "ap-south-1";
let defaultRegion: Promise<string> | undefined;

/** AWS_REGION, then the region of the profile in the AWS config (the SDK's lookup), then ap-south-1. */
export function bedrockRegion(): Promise<string> {
  defaultRegion ??= new BedrockRuntimeClient({}).config.region().catch(() => FALLBACK_REGION);
  return defaultRegion;
}

/**
 * Amazon Bedrock's ConverseStream, the model client (ADR 0012). Credentials come from the AWS SDK's
 * default chain (AWS_PROFILE locally, the task role on ECS) and requests are SigV4-signed: there is
 * no API key. Reasoning the model streams is kept in the transcript but never sent back.
 */
export function createBedrockClient(opts: BedrockClientOptions = {}): ModelClient {
  const runtime: BedrockRuntime =
    opts.runtime ?? new BedrockRuntimeClient({ region: opts.region ?? bedrockRegion });
  return {
    async complete(req, onToken, onToolInput) {
      try {
        const output = (await runtime.send(
          new ConverseStreamCommand(toRequest(req)),
          req.signal ? { abortSignal: req.signal } : undefined,
        )) as { stream?: AsyncIterable<ConverseStreamOutput> };
        return await readStream(req, output.stream, onToken, onToolInput);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        throw bedrockError(err);
      }
    },
  };
}

function toRequest(req: ModelRequest): ConverseStreamCommandInput {
  const system: Array<{ text: string }> = [];
  const messages: WireMessage[] = [];
  // Converse needs user and assistant turns to alternate: tool results go in a user turn, and
  // consecutive blocks of one role are merged into one turn.
  const add = (role: "user" | "assistant", content: ContentBlock[]) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content = [...(last.content ?? []), ...content];
    else messages.push({ role, content });
  };
  for (const m of req.messages) {
    switch (m.role) {
      case "system":
        system.push({ text: m.content });
        break;
      case "user":
        add("user", [text(m.content)]);
        break;
      case "tool":
        add("user", [{ toolResult: { toolUseId: m.toolCallId, content: [text(m.content)] } }]);
        break;
      case "assistant": {
        const calls: ContentBlock[] = (m.toolCalls ?? []).map((call) => ({
          toolUse: { toolUseId: call.id, name: encodeName(call.name), input: parseInput(call) },
        }));
        add("assistant", m.content || calls.length === 0 ? [text(m.content), ...calls] : calls);
        break;
      }
    }
  }
  return {
    modelId: req.model,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(req.tools.length > 0
      ? {
          toolConfig: {
            tools: req.tools.map((t) => ({
              toolSpec: {
                name: encodeName(t.name),
                description: t.description,
                inputSchema: { json: t.parameters as Document },
              },
            })),
          },
        }
      : {}),
  };
}

// Bedrock rejects a blank text block.
const text = (content: string): { text: string } => ({
  text: content.trim() ? content : "(empty)",
});

/** Tool input goes back as a JSON document; arguments the model got wrong are sent as `{}`. */
function parseInput(call: ToolCall): Document {
  try {
    const input: unknown = JSON.parse(call.arguments);
    return input && typeof input === "object" ? (input as Document) : {};
  } catch {
    return {};
  }
}

async function readStream(
  req: ModelRequest,
  stream: AsyncIterable<ConverseStreamOutput> | undefined,
  onToken?: (text: string) => void,
  onToolInput?: (delta: ToolInputDelta) => void,
): Promise<ModelTurn> {
  if (!stream) throw new Error("Bedrock returned no stream");
  let content = "";
  let reasoning = "";
  let stopReason = "";
  let usage: WireUsage | undefined;
  let servedModel: string | undefined;
  const calls: ToolCall[] = [];
  // content block index → the call's position in the turn
  const callAt = new Map<number, number>();

  for await (const event of stream) {
    const failure =
      event.internalServerException ??
      event.modelStreamErrorException ??
      event.validationException ??
      event.throttlingException ??
      event.serviceUnavailableException;
    if (failure) throw failure;

    const toolUse = event.contentBlockStart?.start?.toolUse;
    if (toolUse) {
      callAt.set(event.contentBlockStart?.contentBlockIndex ?? 0, calls.length);
      calls.push({
        id: toolUse.toolUseId ?? "",
        name: decodeName(toolUse.name ?? ""),
        arguments: "",
      });
    }
    const delta = event.contentBlockDelta?.delta;
    if (delta?.text) {
      content += delta.text;
      onToken?.(delta.text);
    }
    if (delta?.reasoningContent?.text) reasoning += delta.reasoningContent.text;
    if (delta?.toolUse?.input) {
      const index = callAt.get(event.contentBlockDelta?.contentBlockIndex ?? 0);
      const call = index === undefined ? undefined : calls[index];
      if (index !== undefined && call) {
        call.arguments += delta.toolUse.input;
        onToolInput?.({ index, callId: call.id, tool: call.name, text: delta.toolUse.input });
      }
    }
    if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
    if (event.metadata) {
      usage = event.metadata.usage;
      servedModel = event.metadata.trace?.promptRouter?.invokedModelId ?? servedModel;
    }
  }

  // a tool with no input streams no fragments
  for (const call of calls) call.arguments ||= "{}";
  const message: AssistantMessage = {
    role: "assistant",
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  };
  return {
    message,
    tokens: {
      // Bedrock counts cache reads and writes apart from `inputTokens`; our input includes them
      inputTokens:
        (usage?.inputTokens ?? 0) +
        (usage?.cacheReadInputTokens ?? 0) +
        (usage?.cacheWriteInputTokens ?? 0),
      cachedInputTokens: usage?.cacheReadInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      // not reported separately
      reasoningTokens: 0,
    },
    servedModel: servedModel ?? req.model,
    finishReason: stopReason,
  };
}

/** An SDK exception as a plain error, named for the service's error code. */
function bedrockError(err: unknown): Error {
  const { name, message } =
    err && typeof err === "object" ? (err as { name?: string; message?: string }) : {};
  return new Error(`Bedrock ${name ?? "error"}: ${message ?? String(err)}`, { cause: err });
}
