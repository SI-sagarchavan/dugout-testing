import type {
  AgentDefinition,
  AgentSpec,
  ApprovalDecision,
  Message,
  RunCheckpoint,
  RunContext,
  RunMemoryContext,
  RunUsage,
  SavedRun,
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
  /**
   * Carry on from saved state instead of starting. `decision` answers the approval the run is
   * waiting for; without one, a waiting run asks again.
   */
  resume?: { saved: SavedRun; reason: "approval" | "recovery"; decision?: ApprovalDecision };
}

export type FailureReason = "budget" | "max_steps" | "invalid_output" | "error";

export type RunResult =
  | { status: "completed"; output: unknown; usage: RunUsage }
  | { status: "rejected"; output: RejectedWrite; usage: RunUsage }
  | { status: "failed"; reason: FailureReason; message: string; usage: RunUsage }
  /** The approver answered later: the state is saved and a decision resumes the run. */
  | { status: "waiting"; approval: NonNullable<RunCheckpoint["waiting"]>; usage: RunUsage };

export interface RejectedWrite {
  tool: string;
  input: unknown;
  by: string;
  reason: string;
}

export class SpecError extends Error {}

/**
 * Thrown (by a store, say, that lost the run's lease) to stop this invocation at once without
 * ending the run: no terminal event, nothing saved. Another invocation owns the run now.
 */
export class RunInterrupted extends Error {}

const UNMADE = "ended without making the changes the reviewer asked for";
const UNKNOWN_OUTCOME =
  "Error: the run stopped while this call was running, so it may or may not have taken effect. Check before calling it again.";

/**
 * The agent loop. Pure control flow: everything with side effects goes through `steps` (model,
 * tool, approval, checkpoint) or `log` (events), so the same loop runs in-process and as a Temporal
 * workflow.
 *
 * Its working memory is the transcript plus a checkpoint (step, spend, counters, change requests,
 * the approval it waits for, progress through the current turn). Both are saved through
 * `steps.checkpoint` after every change, so a run can stop at an approval and be resumed by the
 * decision, or be picked up after a crash from the last change saved.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const { agent, registry, steps, log, resume } = opts;
  const { spec, output } = agent;
  // a resumed run keeps the instructions (memory included) it started with
  assertSupportedSpec(spec, registry, {
    hasContext: opts.context !== undefined || resume !== undefined,
  });
  const saved = resume?.saved;
  if (
    saved &&
    (saved.checkpoint.agentId !== spec.id || saved.checkpoint.agentVersion !== spec.version)
  ) {
    throw new SpecError(
      `${spec.id} v${spec.version} cannot resume a run saved by ${saved.checkpoint.agentId} v${saved.checkpoint.agentVersion}`,
    );
  }

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
  const messages: Message[] = saved
    ? [...saved.messages]
    : [
        {
          role: "system",
          content: opts.context
            ? `${spec.instructions}\n\n${opts.context.text}`
            : spec.instructions,
        },
        {
          role: "user",
          content: typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input),
        },
      ];
  const state: RunCheckpoint = saved
    ? structuredClone(saved.checkpoint)
    : {
        version: 1,
        agentId: spec.id,
        agentVersion: spec.version,
        step: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0,
          budgetCostUsd: 0,
          steps: 0,
        },
        messages: 0,
        lastSeq: 0,
        invalidOutputs: 0,
        blockedFinishes: 0,
        pendingChanges: {},
      };
  const { usage } = state;
  let savedMessages = saved?.messages.length ?? 0;
  let decision = resume?.decision;
  if (decision && !state.waiting) throw new Error("the run is not waiting for an approval");

  /** Saves the checkpoint and the messages added since the last save. */
  const save = async () => {
    state.messages = messages.length;
    state.lastSeq = log.lastSeq();
    await steps.checkpoint?.(structuredClone(state), messages.slice(savedMessages));
    savedMessages = messages.length;
  };
  const pendingNote = () =>
    Object.entries(state.pendingChanges)
      .map(([tool, changes]) => changesMessage(tool, changes))
      .join("\n\n");
  const hasPendingChanges = () => Object.keys(state.pendingChanges).length > 0;

  // The transcript is saved before the terminal event, so a crash in between replays the end
  // rather than losing it. A save that fails here does not stop the run from ending.
  const finalSave = async () => {
    try {
      await save();
    } catch (err) {
      if (err instanceof RunInterrupted) throw err;
    }
  };
  const fail = async (reason: FailureReason, message: string): Promise<RunResult> => {
    await finalSave();
    await log.emit({ type: "run.failed", data: { reason, message, usage: { ...usage } } });
    return { status: "failed", reason, message, usage };
  };
  const complete = async (result: unknown): Promise<RunResult> => {
    await finalSave();
    await log.emit({
      type: "run.completed",
      data: { status: "completed", output: result, usage: { ...usage } },
    });
    return { status: "completed", output: result, usage };
  };

  if (saved) {
    await log.emit({
      type: "run.resumed",
      data: {
        agentId: spec.id,
        agentVersion: spec.version,
        tenantId: opts.ctx.tenantId,
        step: state.step,
        reason: resume.reason,
      },
    });
  } else {
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
    await save();
  }

  /**
   * Answers the calls of the turn in progress that have no tool result yet (all of them, unless
   * the run is resuming part-way through). Returns a result when the run ends or waits.
   */
  const answerTurn = async (turn: NonNullable<RunCheckpoint["turn"]>) => {
    const at = messages.findLastIndex((m) => m.role === "assistant");
    const assistant = messages[at] as Extract<Message, { role: "assistant" }>;
    const answered = new Set(
      messages.slice(at + 1).flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
    );
    const step = state.step;
    // a call that does not run still gets a tool result (the API requires one per call) and a
    // `tool.denied` event, so the run log shows it was planned
    const skip = async (callId: string, tool: string, reason: string, content: string) => {
      await log.emit({
        type: "tool.denied",
        data: { step, callId, tool, stage: "policy", reason },
      });
      messages.push({ role: "tool", toolCallId: callId, content });
    };

    for (const call of assistant.toolCalls ?? []) {
      if (answered.has(call.id)) continue;
      if (turn.changesRequested) {
        await skip(
          call.id,
          call.name,
          "skipped: the reviewer asked for changes to an earlier call in this turn",
          "Not run: the reviewer asked for changes to an earlier call in this turn.",
        );
        await save();
        continue;
      }
      if (output && call.name === FINAL_TOOL) {
        if (hasPendingChanges()) {
          if (++state.blockedFinishes > MAX_INVALID_OUTPUTS) return fail("invalid_output", UNMADE);
          await skip(
            call.id,
            call.name,
            "the reviewer has not approved the changes they asked for",
            "Not accepted: the reviewer has not approved the changes they asked for.",
          );
          turn.remind = true;
          await save();
          continue;
        }
        const result = parseFinal(call, output);
        if (result.ok) return complete(result.value);
        if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
          return fail("invalid_output", result.error);
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Invalid result: ${result.error}`,
        });
        await save();
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
        await save();
        continue;
      }

      // approved before a crash: the reviewer is not asked twice
      if (checked.needsApproval && !turn.approved.includes(call.id)) {
        let answer: ApprovalDecision;
        if (decision && state.waiting?.callId === call.id) {
          answer = decision;
          decision = undefined;
        } else {
          const request = { step, call, tool: call.name, input: checked.input };
          // Saved as waiting, and the wait registered, before the request is announced: a decision
          // sent the moment the event is seen always finds the run waiting for it.
          state.waiting = { step, callId: call.id, tool: call.name, input: checked.input };
          await save();
          const pendingDecision = steps.approval(request);
          // an approver can fail before the request is announced; that error is raised by the
          // await below, not reported as unhandled meanwhile
          pendingDecision.catch(() => {});
          await log.emit({ type: "approval.requested", data: { ...ids, input: checked.input } });
          const got = await pendingDecision;
          if ("pending" in got) {
            await save();
            return { status: "waiting", approval: state.waiting, usage } satisfies RunResult;
          }
          answer = got;
        }
        state.waiting = undefined;

        if (!answer.approved && "changes" in answer) {
          const { by } = answer;
          const changes = answer.changes.trim();
          if (!changes) {
            throw new Error(`the approver sent ${call.name} back with an empty change request`);
          }
          await log.emit({ type: "approval.changes_requested", data: { ...ids, by, changes } });
          state.pendingChanges[call.name] = changes;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `Not run: the reviewer sent ${call.name} back with a change request.`,
          });
          turn.remind = true;
          turn.changesRequested = true;
          await save();
          continue;
        }
        if (!answer.approved) {
          const { by, reason } = answer;
          await log.emit({ type: "approval.rejected", data: { ...ids, by, reason } });
          const rejected = { tool: call.name, input: checked.input, by, reason };
          await save();
          await log.emit({
            type: "run.completed",
            data: { status: "rejected", output: rejected, usage: { ...usage } },
          });
          return { status: "rejected", output: rejected, usage } satisfies RunResult;
        }
        await log.emit({ type: "approval.granted", data: { ...ids, by: answer.by } });
        turn.approved.push(call.id);
        if (call.name in state.pendingChanges) {
          delete state.pendingChanges[call.name];
          state.blockedFinishes = 0;
        }
        await save();
      }

      // Started before a crash and never answered: run it again only if that is safe.
      if (turn.started.includes(call.id)) {
        const tool = registry.get(call.name);
        if (tool?.effect !== "read" && !tool?.retries) {
          await log.emit({
            type: "tool.completed",
            data: { ...ids, ok: false, content: UNKNOWN_OUTCOME, durationMs: 0 },
          });
          messages.push({ role: "tool", toolCallId: call.id, content: UNKNOWN_OUTCOME });
          await save();
          continue;
        }
      } else {
        turn.started.push(call.id);
        await save();
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
      await save();
    }
    return undefined;
  };

  try {
    for (;;) {
      if (!state.turn) {
        if (state.step >= spec.budget.maxSteps) {
          return fail("max_steps", `no result after ${spec.budget.maxSteps} steps`);
        }
        const step = state.step + 1;
        const turn = await steps.model({ step, tier: spec.model.tier, messages, tools });
        state.step = step;
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

        if (!turn.message.toolCalls?.length) {
          if (hasPendingChanges()) {
            if (++state.blockedFinishes > MAX_INVALID_OUTPUTS)
              return fail("invalid_output", UNMADE);
            messages.push({ role: "user", content: pendingNote() });
          } else if (!output) {
            return complete(turn.message.content);
          } else {
            if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
              return fail("invalid_output", `ended without calling ${FINAL_TOOL}`);
            }
            messages.push({
              role: "user",
              content: `Call the ${FINAL_TOOL} tool with your result.`,
            });
          }
          await save();
          continue;
        }
        state.turn = { changesRequested: false, remind: false, approved: [], started: [] };
        await save();
      }

      const ended = await answerTurn(state.turn);
      if (ended) return ended;
      // The reviewer is the person the run works for, so their request comes as a user message,
      // not inside a tool result, which agents are told never to take instructions from. Only
      // changes still outstanding at the end of the turn are restated.
      if (state.turn.remind && hasPendingChanges()) {
        messages.push({ role: "user", content: pendingNote() });
      }
      state.turn = undefined;
      await save();
    }
  } catch (err) {
    if (err instanceof RunInterrupted) throw err;
    return fail("error", err instanceof Error ? err.message : String(err));
  }
}

/** What the reviewer says, as the user, when they send a call back for changes. */
export function changesMessage(tool: string, changes: string): string {
  return [
    `I reviewed your ${tool} call and did not approve it yet. Please change this: ${JSON.stringify(changes)}`,
    `Make only that change and keep everything else exactly as it was, then call ${tool} again with the full updated input.`,
    "This request takes priority over the brief and your earlier choices.",
    `Only if ${tool} itself would refuse the change (it fails validation), call ${tool} again with the closest input it accepts; I will decide.`,
  ].join("\n");
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
