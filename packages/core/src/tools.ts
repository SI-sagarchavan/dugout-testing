import {
  type AgentSpec,
  AwaitingAnswers,
  type DenialStage,
  type RunContext,
  type RunUsage,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
  type ToolStepRequest,
} from "@dugout/contracts";
import { z } from "zod";
import type { OutputStore } from "./output-store.ts";
import { policyViolation } from "./policy.ts";
import { createRedactor, type Redactor } from "./redact.ts";

// Dots only, no underscores, so adapters can encode `.` reversibly for providers that forbid it.
const TOOL_NAME = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

export const READ_OUTPUT_TOOL = "run.readOutput";
/** Tools every agent may call without listing them in its spec. */
export const BUILTIN_TOOLS = [READ_OUTPUT_TOOL];

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  definitions(names: string[]): ToolDefinition[];
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`);
    if (byName.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return {
    get: (name) => byName.get(name),
    definitions: (names) =>
      names.flatMap((name) => {
        const tool = byName.get(name);
        return tool ? [toolDefinition(tool.name, tool.description, tool.input)] : [];
      }),
  };
}

export function toolDefinition(name: string, description: string, input: z.ZodType) {
  const { $schema: _, ...parameters } = z.toJSONSchema(input, { io: "input" }) as Record<
    string,
    unknown
  >;
  if (parameters.type !== "object") throw new Error(`${name}: input schema must be an object`);
  return { name, description, parameters };
}

export type Preflight =
  | { ok: false; stage: DenialStage; reason: string; advisory?: boolean }
  | { ok: true; tool: Tool; input: unknown; needsApproval: boolean };

/**
 * Pipeline stages that need no I/O: registry, spec allow-list, policy and schema check, and the
 * approval decision. The tenant is not an input here; the executor takes it from the run context.
 * `ctx` is the verified run, so a tool can refuse before approval using the host's input.
 */
export function preflight(
  call: ToolCall,
  spec: AgentSpec,
  registry: ToolRegistry,
  ctx?: Pick<ToolContext, "tenantId" | "runId" | "input">,
): Preflight {
  const tool = registry.get(call.name);
  if (!tool) return { ok: false, stage: "registry", reason: `unknown tool ${call.name}` };
  if (!spec.tools.includes(tool.name) && !BUILTIN_TOOLS.includes(tool.name)) {
    return { ok: false, stage: "spec", reason: `${tool.name} is not allowed for ${spec.id}` };
  }

  let args: unknown;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return { ok: false, stage: "policy", reason: "arguments are not valid JSON" };
  }
  const violation = policyViolation(args);
  if (violation) return { ok: false, stage: "policy", reason: violation };
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) {
    return { ok: false, stage: "policy", reason: z.prettifyError(parsed.error) };
  }
  let value: unknown = parsed.data;
  if (tool.resolve) {
    if (!ctx) return { ok: false, stage: "policy", reason: `${tool.name} needs a run context` };
    try {
      value = tool.resolve(parsed.data, ctx);
    } catch (err) {
      return {
        ok: false,
        stage: "policy",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (tool.block && ctx) {
    try {
      const reason = tool.block(value, ctx);
      if (reason) {
        return {
          ok: false,
          stage: "policy",
          reason,
          ...(tool.advisoryBlock ? { advisory: true } : {}),
        };
      }
    } catch (err) {
      return {
        ok: false,
        stage: "policy",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const needsApproval = tool.effect === "write" || spec.approvals.includes(tool.name);
  return { ok: true, tool, input: value, needsApproval };
}

export interface ToolExecutor {
  execute(req: ToolStepRequest, ctx: RunContext): Promise<ToolOutcome>;
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  outputs: OutputStore;
  redactor?: Redactor;
  /** Outputs longer than this are stored and replaced by a reference. */
  maxInlineChars?: number;
}

const PREVIEW_CHARS = 1_000;

/** Pipeline stages with I/O: execute with timeout and retries, redact, then compact. */
export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const redactor = opts.redactor ?? createRedactor();
  const maxInline = opts.maxInlineChars ?? 16_000;

  return {
    async execute({ call, input, usdLeft, answered }, ctx) {
      const tool = opts.registry.get(call.name);
      if (!tool) return { ok: false, error: `unknown tool ${call.name}` };

      // what the call spent besides the run's own turns (a child run), every attempt counted
      let spent: RunUsage | undefined;
      const spend = (usage: RunUsage) => {
        spent = spent ? sumUsage(spent, usage) : { ...usage };
      };
      const forCall = {
        callId: call.id,
        ...(usdLeft !== undefined ? { usdLeft } : {}),
        ...(answered ? { answered } : {}),
        spend,
      };
      const withSpend = (outcome: ToolOutcome): ToolOutcome =>
        spent ? { ...outcome, usage: spent } : outcome;

      let lastError = "";
      for (let attempt = 0; attempt <= (tool.retries ?? 0); attempt++) {
        try {
          const output = await runWithTimeout(tool, input, ctx, forCall);
          const content = redactor.text(
            typeof output === "string" ? output : JSON.stringify(output ?? null),
          );
          if (tool.alwaysInline || content.length <= maxInline) {
            return withSpend({ ok: true, content });
          }
          const ref = await opts.outputs.put(ctx.runId, content);
          return withSpend({
            ok: true,
            content: JSON.stringify({
              ref,
              chars: content.length,
              preview: content.slice(0, PREVIEW_CHARS),
              note: `Output truncated. Call ${READ_OUTPUT_TOOL} with this ref to read the rest.`,
            }),
          });
        } catch (err) {
          // a tool, or a child run, stopping to ask a person: the loop waits, then runs it again
          if (err instanceof AwaitingAnswers) throw err;
          lastError = redactor.text(err instanceof Error ? err.message : String(err));
        }
      }
      return withSpend({ ok: false, error: lastError });
    },
  };
}

function sumUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd + b.costUsd,
    budgetCostUsd: a.budgetCostUsd + b.budgetCostUsd,
    steps: a.steps + b.steps,
  };
}

async function runWithTimeout(
  tool: Tool,
  input: unknown,
  ctx: RunContext,
  call: Pick<ToolContext, "callId" | "usdLeft" | "spend" | "answered">,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${tool.name} timed out after ${tool.timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, tool.timeoutMs);
  });
  try {
    const toolCtx: ToolContext = {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      signal: controller.signal,
      ...(ctx.input !== undefined ? { input: ctx.input } : {}),
      depth: ctx.depth ?? 0,
      ...call,
    };
    return await Promise.race([tool.run(input, toolCtx), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export function createReadOutputTool(outputs: OutputStore): Tool<
  {
    ref: string;
    offset: number;
    limit: number;
  },
  string
> {
  return {
    name: READ_OUTPUT_TOOL,
    description: "Read part of a tool output that was too long to show in full.",
    input: z.object({
      ref: z.string().describe("The ref from the truncated output"),
      offset: z.number().int().min(0).default(0).describe("Character offset to start at"),
      limit: z.number().int().min(1).max(12_000).default(8_000).describe("Characters to read"),
    }),
    effect: "read",
    timeoutMs: 5_000,
    async run({ ref, offset, limit }, ctx) {
      const content = await outputs.read(ctx.runId, ref);
      if (content === undefined) throw new Error(`no output ${ref} in this run`);
      return content.slice(offset, offset + limit);
    },
  };
}
