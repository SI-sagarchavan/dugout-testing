import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type SystemContentBlock,
  type Tool,
  type ToolInputSchema,
  type Message as WireMessage,
  type TokenUsage as WireUsage,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  AssistantMessage,
  ModelClient,
  ModelRequest,
  ModelTurn,
  ReasoningBlock,
  ToolCall,
  ToolDefinition,
  ToolInputDelta,
} from "@dugout/contracts";
import {
  loadModelConfig,
  type ModelConfig,
  type ModelEntry,
  type ModelFamily,
  modelEntry,
  modelFamily,
} from "./config.ts";

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
  /** The names requests can use; defaults to `loadModelConfig()`. */
  models?: ModelConfig;
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
 * no API key. A request names a model in the model list, and the client sends that model's id,
 * effort and output limit the way its family takes them (ADR 0015).
 */
export function createBedrockClient(opts: BedrockClientOptions = {}): ModelClient {
  const runtime: BedrockRuntime =
    opts.runtime ?? new BedrockRuntimeClient({ region: opts.region ?? bedrockRegion });
  const models = opts.models ?? loadModelConfig();
  return {
    async complete(req, onToken, onToolInput) {
      const model = modelEntry(models, req.model);
      try {
        const output = (await runtime.send(
          new ConverseStreamCommand(toRequest(req, model)),
          req.signal ? { abortSignal: req.signal } : undefined,
        )) as { stream?: AsyncIterable<ConverseStreamOutput> };
        return await readStream(model, output.stream, onToken, onToolInput);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        throw bedrockError(err);
      }
    },
  };
}

function toRequest(req: ModelRequest, model: ModelEntry): ConverseStreamCommandInput {
  // the model list only holds ids of a known family
  const family = modelFamily(model.id) as ModelFamily;
  const system: SystemContentBlock[] = [];
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
        // Claude's signed reasoning goes back first and unchanged, or the model loses it
        const reasoning: ContentBlock[] =
          family === "claude" ? (m.reasoningBlocks ?? []).map(reasoningContent) : [];
        const calls: ContentBlock[] = (m.toolCalls ?? []).map((call) => ({
          toolUse: { toolUseId: call.id, name: encodeName(call.name), input: parseInput(call) },
        }));
        const reply = m.content || calls.length === 0 ? [text(m.content)] : [];
        add("assistant", [...reasoning, ...reply, ...calls]);
        break;
      }
    }
  }
  if (req.cache) addCachePoints(family, system, messages);
  // Nova 2 refuses maxTokens when it reasons at high effort
  const maxTokens =
    family === "nova-2" && model.effort === "high" ? {} : { maxTokens: model.maxOutputTokens };
  return {
    modelId: model.id,
    messages,
    ...(system.length > 0 ? { system } : {}),
    inferenceConfig: maxTokens,
    ...effort(family, model),
    ...(req.tools.length > 0
      ? { toolConfig: { tools: req.tools.map((t) => toolSpec(t, model.strictTools)) } }
      : {}),
  };
}

/** Claude takes effort as `outputConfig`; Nova 2 as a reasoning config; Nova v1 takes none. */
function effort(family: ModelFamily, model: ModelEntry): Partial<ConverseStreamCommandInput> {
  if (!model.effort) return {};
  if (family === "claude") return { outputConfig: { effort: model.effort } };
  if (family === "nova-2") {
    return {
      additionalModelRequestFields: {
        reasoningConfig: { type: "enabled", maxReasoningEffort: model.effort },
      },
    };
  }
  return {};
}

const CACHE_POINT = { cachePoint: { type: "default" } } as const;

/**
 * A cache point after the system prompt, and one at the end of the newest turn that takes it, so
 * the next turn reads the transcript so far from the cache. Claude takes one in any turn; Nova
 * only in a turn of text alone, not beside a tool call or result.
 */
function addCachePoints(
  family: ModelFamily,
  system: SystemContentBlock[],
  messages: WireMessage[],
) {
  if (system.length > 0) system.push(CACHE_POINT);
  const takes = (m: WireMessage) =>
    family === "claude" || (m.content ?? []).every((block) => "text" in block);
  const last = messages.findLast(takes);
  if (last) last.content = [...(last.content ?? []), CACHE_POINT];
}

function toolSpec(t: ToolDefinition, strictTools: boolean): Tool {
  const strict = strictTools ? strictSchema(t.parameters) : undefined;
  return {
    toolSpec: {
      name: encodeName(t.name),
      description: t.description,
      inputSchema: { json: (strict ?? t.parameters) as Document },
      ...(strict ? { strict: true } : {}),
    },
  };
}

// Strict mode can't express these; zod still checks them when the call arrives.
const UNCONSTRAINED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/**
 * A tool's schema the way strict mode takes it: every object closed and the constraints it can't
 * express left out. Undefined when the schema has an open object (a record), which strict mode
 * can't take; that tool goes without strict.
 */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNCONSTRAINED.has(key)) continue;
      if (key === "additionalProperties" && value !== false) throw OPEN;
      out[key] =
        key === "properties" || key === "$defs"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
            )
          : walk(value);
    }
    if (out.type === "object") out.additionalProperties = false;
    return out;
  };
  try {
    return walk(schema) as Record<string, unknown>;
  } catch (err) {
    if (err === OPEN) return undefined;
    throw err;
  }
}
const OPEN = new Error("open object");

function reasoningContent(block: ReasoningBlock): ContentBlock {
  return {
    reasoningContent:
      "redacted" in block
        ? { redactedContent: Buffer.from(block.redacted, "base64") }
        : { reasoningText: { text: block.text, signature: block.signature } },
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
  model: ModelEntry,
  stream: AsyncIterable<ConverseStreamOutput> | undefined,
  onToken?: (text: string) => void,
  onToolInput?: (delta: ToolInputDelta) => void,
): Promise<ModelTurn> {
  if (!stream) throw new Error("Bedrock returned no stream");
  let content = "";
  let stopReason = "";
  let usage: WireUsage | undefined;
  let servedModel: string | undefined;
  const calls: ToolCall[] = [];
  // content block index → the call's position in the turn
  const callAt = new Map<number, number>();
  // content block index → reasoning streamed into it
  const thoughts = new Map<number, { text: string; signature?: string; redacted?: Uint8Array }>();

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
    if (delta?.reasoningContent) {
      const index = event.contentBlockDelta?.contentBlockIndex ?? 0;
      const thought = thoughts.get(index) ?? { text: "" };
      thoughts.set(index, thought);
      const { text, signature, redactedContent } = delta.reasoningContent;
      if (text) thought.text += text;
      if (signature) thought.signature = signature;
      if (redactedContent) thought.redacted = redactedContent;
    }
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
  const ordered = [...thoughts.entries()].sort(([a], [b]) => a - b).map(([, t]) => t);
  const reasoning = ordered.map((t) => t.text).join("");
  // only signed or encrypted reasoning can go back to the model
  const blocks: ReasoningBlock[] = ordered.flatMap((t): ReasoningBlock[] => {
    if (t.redacted) return [{ redacted: Buffer.from(t.redacted).toString("base64") }];
    return t.signature ? [{ text: t.text, signature: t.signature }] : [];
  });
  const message: AssistantMessage = {
    role: "assistant",
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(blocks.length > 0 ? { reasoningBlocks: blocks } : {}),
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
      cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      // not reported separately
      reasoningTokens: 0,
    },
    servedModel: servedModel ?? model.id,
    finishReason: stopReason,
  };
}

/** An SDK exception as a plain error, named for the service's error code. */
function bedrockError(err: unknown): Error {
  const { name, message } =
    err && typeof err === "object" ? (err as { name?: string; message?: string }) : {};
  return new Error(`Bedrock ${name ?? "error"}: ${message ?? String(err)}`, { cause: err });
}
