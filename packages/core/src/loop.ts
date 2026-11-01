import type {
  AgentDefinition,
  AgentSpec,
  ApprovalDecision,
  Message,
  RunCheckpoint,
  RunContext,
  RunMemoryContext,
  RunUsage,
  SavedAfter,
  SavedRun,
  Steps,
  StepUsage,
  ToolCall,
} from "@dugout/contracts";
import { z } from "zod";
import type { RunLog } from "./events.ts";
import { TransientModelError } from "./model/errors.ts";
import { BUILTIN_TOOLS, preflight, type ToolRegistry, toolDefinition } from "./tools.ts";

export const FINAL_TOOL = "final";
/** Invalid `final` calls (or turns that skip it) tolerated before the run fails. */
const MAX_INVALID_OUTPUTS = 2;
/** The same call failing this many times in a row ends the run. */
const MAX_SAME_FAILURES = 3;

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

export type FailureReason = "budget" | "max_steps" | "invalid_output" | "model_stop" | "error";

/** Stops where continuing is pointless: the provider ended the reply on purpose. */
const TERMINAL_STOPS = new Set([
  "guardrail_intervened",
  "content_filtered",
  "model_context_window_exceeded",
  "refusal",
]);
/** Asks for the result; the turn after it must be `final`. */
const FINAL_NUDGE = `Call the ${FINAL_TOOL} tool with your result.`;
/** Stops where the reply is unusable but another try may work. */
const CUT_OFF_STOPS = new Set(["max_tokens", "malformed_tool_use", "malformed_model_output"]);

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
  const final = output ? finalSchema(output) : undefined;
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
  // an agent that lists a tool that writes is expected to use it, unless it says this run won't
  const writeExpected =
    agent.writeExpected?.(opts.ctx.input) ??
    spec.tools.some((name) => registry.get(name)?.effect === "write");
  if (final) {
    tools.push(
      toolDefinition(
        FINAL_TOOL,
        final.wrapped
          ? "Submit your final result as `result`. The run ends when this call is valid."
          : "Submit your final result. The run ends when this call is valid.",
        final.schema,
      ),
    );
  }
  const inputText = typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input);
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
          // recalled memory goes here, not in the system prompt, so the prompt stays cacheable
          content: opts.context?.recalled ? `${opts.context.recalled}\n\n${inputText}` : inputText,
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
          cacheWriteInputTokens: 0,
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
        wrote: false,
        pendingChanges: {},
      };
  const { usage } = state;
  let savedMessages = saved?.messages.length ?? 0;
  let decision = resume?.decision;
  if (decision && !state.waiting) throw new Error("the run is not waiting for an approval");

  /** Saves the checkpoint and the messages added since the last save, as a new save point. */
  const save = async (after: SavedAfter) => {
    state.savedAfter = after;
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
      await save("end");
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
        // the first invocation of a fork carries on from its parent's save point
        ...(state.savedAfter === "fork" && state.forkedFrom
          ? { reason: "fork" as const, forkedFrom: state.forkedFrom }
          : { reason: resume.reason }),
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
    await save("start");
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
      messages.push({ role: "tool", toolCallId: callId, content, isError: true });
    };

    for (const call of assistant.toolCalls ?? []) {
      if (answered.has(call.id)) continue;
      if (turn.cutOff) {
        // a call from a cut-off reply may be half written, even if its JSON parses
        const why = turn.cutOffReason ?? "max_tokens";
        await skip(
          call.id,
          call.name,
          `skipped: the reply was cut off (${why})`,
          `Not run: your reply was cut off (${why}). Send it again, shorter.`,
        );
        await save("tool");
        continue;
      }
      if (turn.changesRequested) {
        await skip(
          call.id,
          call.name,
          "skipped: the reviewer asked for changes to an earlier call in this turn",
          "Not run: the reviewer asked for changes to an earlier call in this turn.",
        );
        await save("tool");
        continue;
      }
      if (final && call.name === FINAL_TOOL) {
        if (hasPendingChanges()) {
          if (++state.blockedFinishes > MAX_INVALID_OUTPUTS) return fail("invalid_output", UNMADE);
          await skip(
            call.id,
            call.name,
            "the reviewer has not approved the changes they asked for",
            "Not accepted: the reviewer has not approved the changes they asked for.",
          );
          turn.remind = true;
          await save("tool");
          continue;
        }
        // a write that failed in this turn may have left the work undone
        if (turn.failed) {
          if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
            return fail("invalid_output", `${FINAL_TOOL} sent after ${turn.failed} failed`);
          }
          await skip(
            call.id,
            call.name,
            `${turn.failed} failed in this turn`,
            `Not accepted: ${turn.failed} failed in this turn. Deal with that before calling ${FINAL_TOOL}.`,
          );
          await save("tool");
          continue;
        }
        const result = parseFinal(call, final.schema);
        if (result.ok) {
          const unwrapped = final.unwrap(result.value);
          const value = agent.completeFinal
            ? agent.completeFinal(unwrapped, { ctx: opts.ctx, messages })
            : unwrapped;
          const refusal = agent.verifyFinal?.(value, { ctx: opts.ctx, messages });
          if (refusal === undefined) return complete(value);
          if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) return fail("invalid_output", refusal);
          await log.emit({
            type: "final.refused",
            data: { step, callId: call.id, reason: refusal },
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `Not accepted: ${refusal}`,
            isError: true,
          });
          await save("tool");
          continue;
        }
        if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
          return fail("invalid_output", result.error);
        }
        await log.emit({
          type: "final.refused",
          data: { step, callId: call.id, reason: result.error },
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Invalid result: ${result.error}`,
          isError: true,
        });
        await save("tool");
        continue;
      }

      const ids = { step, callId: call.id, tool: call.name };
      const checked = preflight(call, spec, registry, {
        tenantId: opts.ctx.tenantId,
        runId: opts.ctx.runId,
        ...(opts.ctx.input !== undefined ? { input: opts.ctx.input } : {}),
      });
      if (!checked.ok) {
        turn.failed = call.name;
        const args = stableArgs(call.arguments);
        // One refusal is feedback. The same call again is the model stuck, so the run stops
        // instead of spending the rest of its steps on copies.
        if (state.refused?.tool === call.name && state.refused.args === args) {
          const message = `${call.name} was refused, and the same call was sent again unchanged`;
          await log.emit({
            type: "tool.denied",
            data: { ...ids, stage: checked.stage, reason: message },
          });
          messages.push({ role: "tool", toolCallId: call.id, content: message, isError: true });
          await save("tool");
          return fail("invalid_output", message);
        }
        state.refused = { tool: call.name, args };
        await log.emit({
          type: "tool.denied",
          data: { ...ids, stage: checked.stage, reason: checked.reason },
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Denied (${checked.stage}): ${checked.reason}`,
          isError: true,
        });
        await save("tool");
        continue;
      }
      state.refused = undefined;

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
          await save("waiting");
          const pendingDecision = steps.approval(request);
          // an approver can fail before the request is announced; that error is raised by the
          // await below, not reported as unhandled meanwhile
          pendingDecision.catch(() => {});
          await log.emit({ type: "approval.requested", data: { ...ids, input: checked.input } });
          const got = await pendingDecision;
          if ("pending" in got) {
            await save("waiting");
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
          await save("decision");
          continue;
        }
        if (!answer.approved) {
          const { by, reason } = answer;
          await log.emit({ type: "approval.rejected", data: { ...ids, by, reason } });
          const rejected = { tool: call.name, input: checked.input, by, reason };
          await save("decision");
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
        await save("decision");
      }

      // Started before a crash and never answered: run it again only if that is safe.
      if (turn.started.includes(call.id)) {
        const tool = registry.get(call.name);
        if (tool?.effect !== "read" && !tool?.retries) {
          await log.emit({
            type: "tool.completed",
            data: { ...ids, ok: false, content: UNKNOWN_OUTCOME, durationMs: 0 },
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: UNKNOWN_OUTCOME,
            isError: true,
          });
          turn.failed = call.name;
          await save("tool");
          continue;
        }
      } else {
        turn.started.push(call.id);
        await save("call");
      }

      await log.emit({ type: "tool.started", data: { ...ids, input: checked.input } });
      const started = Date.now();
      const outcome = await steps.tool({ step, call, input: checked.input });
      const content = outcome.ok ? outcome.content : `Error: ${outcome.error}`;
      if (!outcome.ok) turn.failed = call.name;
      // the same call failing again and again is the model stuck, like a refused copy of it
      const args = stableArgs(call.arguments);
      const repeated = state.failedCall;
      state.failedCall = outcome.ok
        ? undefined
        : {
            tool: call.name,
            args,
            count: repeated?.tool === call.name && repeated.args === args ? repeated.count + 1 : 1,
          };
      await log.emit({
        type: "tool.completed",
        data: { ...ids, ok: outcome.ok, content, durationMs: Date.now() - started },
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content,
        ...(outcome.ok ? {} : { isError: true }),
      });
      if (outcome.ok && registry.get(call.name)?.effect === "write") state.wrote = true;
      await save("tool");
      if (state.failedCall && state.failedCall.count >= MAX_SAME_FAILURES) {
        return fail(
          "invalid_output",
          `${call.name} failed ${MAX_SAME_FAILURES} times with the same input`,
        );
      }
    }
    return undefined;
  };

  try {
    for (;;) {
      if (!state.turn) {
        if (state.step >= spec.budget.maxSteps) {
          return fail("max_steps", `no result after ${spec.budget.maxSteps} steps`);
        }
        // two turns left: one to spare for a mistake, then the last
        if (spec.budget.maxSteps - state.step === 2 && !state.stepsWarned) {
          state.stepsWarned = true;
          messages.push({
            role: "user",
            content: `2 model turns left. Finish now.${output ? `\nCall ${FINAL_TOOL} with your result.` : ""}`,
          });
          await save("model");
        }
        const step = state.step + 1;
        // the last step, and the turn after a nudge, must end the run
        const last = messages.at(-1);
        const forceFinal =
          output !== undefined &&
          // A model forced to answer before it saved ends "completed" with nothing saved.
          (state.wrote || !writeExpected) &&
          (step >= spec.budget.maxSteps || (last?.role === "user" && last.content === FINAL_NUDGE));
        const turn = await steps.model({
          step,
          model: spec.model,
          messages,
          tools,
          ...(forceFinal ? { toolChoice: { tool: FINAL_TOOL } } : {}),
        });
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

        if (TERMINAL_STOPS.has(turn.finishReason)) {
          return fail("model_stop", `the model stopped the reply: ${turn.finishReason}`);
        }
        const cutOff = CUT_OFF_STOPS.has(turn.finishReason);
        if (cutOff && ++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
          return fail(
            "model_stop",
            `the reply was cut off ${state.invalidOutputs} times (${turn.finishReason})`,
          );
        }

        if (!turn.message.toolCalls?.length) {
          if (cutOff) {
            messages.push({
              role: "user",
              content: `Your reply was cut off (${turn.finishReason}). Send it again, shorter.`,
            });
          } else if (hasPendingChanges()) {
            if (++state.blockedFinishes > MAX_INVALID_OUTPUTS)
              return fail("invalid_output", UNMADE);
            messages.push({ role: "user", content: pendingNote() });
          } else if (!output) {
            return complete(turn.message.content);
          } else {
            if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
              return fail("invalid_output", `ended without calling ${FINAL_TOOL}`);
            }
            messages.push({ role: "user", content: FINAL_NUDGE });
          }
          await save("model");
          continue;
        }
        state.turn = {
          changesRequested: false,
          remind: false,
          approved: [],
          started: [],
          ...(cutOff ? { cutOff: true, cutOffReason: turn.finishReason } : {}),
        };
        await save("model");
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
      await save("tool");
    }
  } catch (err) {
    if (err instanceof RunInterrupted) throw err;
    // With a save to resume from, a transient failure is left to the host: the worker records it,
    // the lease runs out and the run is claimed again, up to its attempts.
    if (err instanceof TransientModelError && steps.checkpoint) throw err;
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
  const skills = spec.skills.length + spec.onDemandSkills.length;
  if ((spec.memory.read.length > 0 || skills > 0) && !hasContext) {
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

/**
 * `final`'s parameters must be an object, so an output that isn't one (a union of variants, a
 * list) is wrapped as `{ result }` for the model and unwrapped after the check.
 */
function finalSchema(output: z.ZodType) {
  const json = z.toJSONSchema(output, { io: "input" }) as { type?: unknown };
  if (json.type === "object") return { schema: output, wrapped: false, unwrap: (v: unknown) => v };
  return {
    schema: z.object({ result: output }),
    wrapped: true,
    unwrap: (v: unknown) => (v as { result: unknown }).result,
  };
}

/** Stable JSON so key order does not make two copies of a call look different. */
function stableArgs(raw: string): string {
  try {
    return JSON.stringify(sortJson(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
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
  total.cacheWriteInputTokens += step.cacheWriteInputTokens;
  total.outputTokens += step.outputTokens;
  total.reasoningTokens += step.reasoningTokens;
  total.costUsd += step.costUsd;
  total.budgetCostUsd += step.budgetCostUsd;
  total.steps += 1;
}
