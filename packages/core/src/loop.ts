import type {
  AgentDefinition,
  AgentSpec,
  Message,
  RunContext,
  RunMemoryContext,
  RunUsage,
  Steps,
  StepUsage,
  ToolCall,
} from "@dugout/contracts";
import { z } from "zod";
import type { RunLog } from "./events.ts";
import { BUILTIN_TOOLS, preflight, type ToolRegistry, toolDefinition } from "./tools.ts";

export const FINAL_TOOL = "final";
/** Invalid `final` calls (or turns that skip it) tolerated before the run fails. */
const MAX_INVALID_OUTPUTS = 2;

export interface RunAgentOptions {
  agent: AgentDefinition;
  input: unknown;
  ctx: RunContext;
  registry: ToolRegistry;
  steps: Steps;
  log: RunLog;
  /** Skills and memory to append to the instructions; required when the spec reads memory. */
  context?: RunMemoryContext;
}

export type FailureReason = "budget" | "max_steps" | "invalid_output" | "error";

export type RunResult =
  | { status: "completed"; output: unknown; usage: RunUsage }
  | { status: "rejected"; output: RejectedWrite; usage: RunUsage }
  | { status: "failed"; reason: FailureReason; message: string; usage: RunUsage };

export interface RejectedWrite {
  tool: string;
  input: unknown;
  by: string;
  reason: string;
}

export class SpecError extends Error {}

/**
 * The agent loop. Pure control flow: everything with side effects goes through `steps` (model,
 * tool, approval) or `log` (events), so the same loop runs in-process and as a Temporal workflow.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const { agent, registry, steps, log } = opts;
  const { spec, output } = agent;
  assertSupportedSpec(spec, registry, { hasContext: opts.context !== undefined });

  const tools = registry.definitions([...spec.tools, ...BUILTIN_TOOLS]);
  if (output) {
    tools.push(
      toolDefinition(
        FINAL_TOOL,
        "Submit your final result. The run ends when this call is valid.",
        output,
      ),
    );
  }
  const messages: Message[] = [
    {
      role: "system",
      content: opts.context ? `${spec.instructions}\n\n${opts.context.text}` : spec.instructions,
    },
    {
      role: "user",
      content: typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input),
    },
  ];
  const usage: RunUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    budgetCostUsd: 0,
    steps: 0,
  };

  const fail = async (reason: FailureReason, message: string): Promise<RunResult> => {
    await log.emit({ type: "run.failed", data: { reason, message, usage: { ...usage } } });
    return { status: "failed", reason, message, usage };
  };
  const complete = async (result: unknown): Promise<RunResult> => {
    await log.emit({
      type: "run.completed",
      data: { status: "completed", output: result, usage: { ...usage } },
    });
    return { status: "completed", output: result, usage };
  };

  await log.emit({
    type: "run.started",
    data: {
      agentId: spec.id,
      agentVersion: spec.version,
      tenantId: opts.ctx.tenantId,
      input: opts.input,
    },
  });
  if (opts.context) {
    const { tokens, sources } = opts.context;
    await log.emit({ type: "context.built", data: { tokens, sources } });
  }

  let invalidOutputs = 0;
  try {
    for (let step = 1; step <= spec.budget.maxSteps; step++) {
      const turn = await steps.model({ step, tier: spec.model.tier, messages, tools });
      addUsage(usage, turn.usage);
      messages.push(turn.message);
      await log.emit({
        type: "step.completed",
        data: {
          step,
          message: turn.message,
          usage: turn.usage,
          servedModel: turn.servedModel,
          finishReason: turn.finishReason,
        },
      });
      if (usage.budgetCostUsd > spec.budget.usdPerRun) {
        return fail(
          "budget",
          `spent $${usage.budgetCostUsd.toFixed(4)} of $${spec.budget.usdPerRun} budget`,
        );
      }

      const calls = turn.message.toolCalls ?? [];
      if (calls.length === 0) {
        if (!output) return complete(turn.message.content);
        if (++invalidOutputs > MAX_INVALID_OUTPUTS) {
          return fail("invalid_output", `ended without calling ${FINAL_TOOL}`);
        }
        messages.push({ role: "user", content: `Call the ${FINAL_TOOL} tool with your result.` });
        continue;
      }

      for (const call of calls) {
        if (output && call.name === FINAL_TOOL) {
          const result = parseFinal(call, output);
          if (result.ok) return complete(result.value);
          if (++invalidOutputs > MAX_INVALID_OUTPUTS) return fail("invalid_output", result.error);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `Invalid result: ${result.error}`,
          });
          continue;
        }

        const ids = { step, callId: call.id, tool: call.name };
        const checked = preflight(call, spec, registry);
        if (!checked.ok) {
          await log.emit({
            type: "tool.denied",
            data: { ...ids, stage: checked.stage, reason: checked.reason },
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `Denied (${checked.stage}): ${checked.reason}`,
          });
          continue;
        }

        if (checked.needsApproval) {
          // Register the wait before announcing it, so an approver reacting to the event at once
          // always finds it.
          const pendingDecision = steps.approval({
            step,
            call,
            tool: call.name,
            input: checked.input,
          });
          await log.emit({ type: "approval.requested", data: { ...ids, input: checked.input } });
          const decision = await pendingDecision;
          if (!decision.approved) {
            const { by, reason } = decision;
            await log.emit({ type: "approval.rejected", data: { ...ids, by, reason } });
            const rejected = { tool: call.name, input: checked.input, by, reason };
            await log.emit({
              type: "run.completed",
              data: { status: "rejected", output: rejected, usage: { ...usage } },
            });
            return { status: "rejected", output: rejected, usage };
          }
          await log.emit({ type: "approval.granted", data: { ...ids, by: decision.by } });
        }

        await log.emit({ type: "tool.started", data: { ...ids, input: checked.input } });
        const started = Date.now();
        const outcome = await steps.tool({ step, call, input: checked.input });
        const content = outcome.ok ? outcome.content : `Error: ${outcome.error}`;
        await log.emit({
          type: "tool.completed",
          data: { ...ids, ok: outcome.ok, content, durationMs: Date.now() - started },
        });
        messages.push({ role: "tool", toolCallId: call.id, content });
      }
    }
    return fail("max_steps", `no result after ${spec.budget.maxSteps} steps`);
  } catch (err) {
    return fail("error", err instanceof Error ? err.message : String(err));
  }
}

/** Rejects specs that use features the harness doesn't have yet, instead of ignoring them. */
export function assertSupportedSpec(
  spec: AgentSpec,
  registry: ToolRegistry,
  { hasContext }: { hasContext: boolean },
): void {
  if ((spec.memory.read.length > 0 || spec.skills.length > 0) && !hasContext) {
    throw new SpecError(`${spec.id}: reads memory or skills but the run has no memory context`);
  }
  if (spec.budget.maxDepth > 0) throw new SpecError(`${spec.id}: sub-agents are not supported yet`);
  for (const name of spec.tools) {
    if (name === FINAL_TOOL) throw new SpecError(`${spec.id}: ${FINAL_TOOL} is reserved`);
    if (!registry.get(name)) throw new SpecError(`${spec.id}: unknown tool ${name}`);
  }
  for (const entry of spec.approvals) {
    if (entry !== "effect:write" && !spec.tools.includes(entry)) {
      throw new SpecError(`${spec.id}: approval for ${entry}, which is not in tools`);
    }
  }
}

function parseFinal(
  call: ToolCall,
  schema: z.ZodType,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
  const parsed = schema.safeParse(args);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

function addUsage(total: RunUsage, step: StepUsage): void {
  total.inputTokens += step.inputTokens;
  total.cachedInputTokens += step.cachedInputTokens;
  total.outputTokens += step.outputTokens;
  total.reasoningTokens += step.reasoningTokens;
  total.costUsd += step.costUsd;
  total.budgetCostUsd += step.budgetCostUsd;
  total.steps += 1;
}
