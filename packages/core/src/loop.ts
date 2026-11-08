import {
  type AgentDefinition,
  type AgentSpec,
  type Answers,
  type AskedQuestion,
  AskInput,
  AUTO_APPROVED,
  AwaitingAnswers,
  type Decision,
  FROM_MEMORY,
  type Message,
  NEEDS_SETUP,
  proposedAnswers,
  type Question,
  REVIEW_ID,
  type ReviewAnswer,
  type RunCheckpoint,
  type RunContext,
  type RunMemoryContext,
  type RunUsage,
  reviewQuestion,
  type SavedAfter,
  type SavedRun,
  type Steps,
  type StepUsage,
  type Subject,
  type ToolCall,
  type ToolOutcome,
} from "@dugout/contracts";
import { z } from "zod";
import { compact, compactedView, SUMMARY_SYSTEM } from "./compact.ts";
import { SpecError } from "./errors.ts";
import type { RunLog } from "./events.ts";
import {
  carryOverLegacyState,
  changesMessage,
  createHooks,
  FINAL_NUDGE,
  harnessHooks,
} from "./hooks.ts";
import { TransientModelError } from "./model/errors.ts";
import { BUILTIN_TOOLS, preflight, type ToolRegistry, toolDefinition } from "./tools.ts";

export const FINAL_TOOL = "final";
/** Built in like `final`: the run stops and asks a person, and waits for the answers (ADR 0029). */
export const ASK_TOOL = "ask";
const ASK_DESCRIPTION =
  "Stop and ask a person what only they can settle: a choice the design and the data leave open, a value no tool can find (a domain, an id), or whether to go a way that costs something. Ask everything you need now in one call; the person answers each question and submits them together, and the run waits until they do. The answers come back as this call's result. Say in each question's why what you found, give options where there are some, and propose your best answer. Do not ask what a tool can find out, and do not ask to approve a write: writes are approved already.";
/** Invalid `final` calls (or turns that skip it) tolerated before the run fails. */
const MAX_INVALID_OUTPUTS = 2;

/**
 * What a run has learned from the answers people gave before (ADR 0029). The loop asks it before it
 * stops for a person: `refine` puts what was learned into each question's proposal, and `answer`
 * returns the answers when a person has approved every one of these questions as a standing
 * answer, so the run need not stop at all.
 */
export interface AnswerMemory {
  refine(questions: AskedQuestion[]): Promise<AskedQuestion[]>;
  answer(questions: AskedQuestion[]): Promise<Answers | undefined>;
}

export interface RunAgentOptions {
  agent: AgentDefinition;
  input: unknown;
  ctx: RunContext;
  registry: ToolRegistry;
  steps: Steps;
  log: RunLog;
  /** Skills and memory to append to the instructions; required when the spec reads memory. */
  context?: RunMemoryContext;
  /** What earlier answers tell this run about the questions it asks. */
  learned?: AnswerMemory;
  /** Makes the request smaller when it nears the model's window; without it nothing is compacted. */
  compaction?: {
    window: number;
    at?: number;
    keep?: number;
    /** A model name; writes the summary of older turns. */
    summarizer: string;
    /** Stores a tool result that leaves the transcript, and returns its reference. */
    store(content: string): Promise<string>;
  };
  /**
   * Carry on from saved state instead of starting. `decision` answers the questions the run is
   * waiting on; without one, a waiting run asks again.
   */
  resume?: { saved: SavedRun; reason: "answered" | "recovery"; decision?: Decision };
}

export type FailureReason = "budget" | "max_steps" | "invalid_output" | "model_stop" | "error";

/** Stops where continuing is pointless: the provider ended the reply on purpose. */
const TERMINAL_STOPS = new Set([
  "guardrail_intervened",
  "content_filtered",
  "model_context_window_exceeded",
  "refusal",
]);
/** Stops where the reply is unusable but another try may work. */
const CUT_OFF_STOPS = new Set(["max_tokens", "malformed_tool_use", "malformed_model_output"]);

export type RunResult =
  | { status: "completed"; output: unknown; usage: RunUsage }
  | { status: "rejected"; output: RejectedWrite; usage: RunUsage }
  | { status: "failed"; reason: FailureReason; message: string; usage: RunUsage }
  /** The host answers later: the state is saved and the person's decision resumes the run. */
  | { status: "waiting"; waiting: NonNullable<RunCheckpoint["waiting"]>; usage: RunUsage };

export interface RejectedWrite {
  tool: string;
  input: unknown;
  by: string;
  reason: string;
}

export { SpecError };

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
  // not strict: its schema is rich, and it is offered to every agent (see ToolDefinition.strict)
  tools.push({
    ...toolDefinition(ASK_TOOL, askDescription(spec), AskInput),
    strict: false,
  });
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
        // a child starts on what its parent works on (ADR 0033)
        ...(opts.ctx.situation ? { situation: opts.ctx.situation } : {}),
      };
  carryOverLegacyState(state);
  const hooks = createHooks([...harnessHooks(agent), ...(agent.hooks ?? [])], state);
  const { usage } = state;
  let savedMessages = saved?.messages.length ?? 0;
  let decision = resume?.decision;
  if (decision && !state.waiting) throw new Error("the run is not waiting for a person");

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
    state.ended = { status: "failed", reason, message };
    await finalSave();
    await log.emit({ type: "run.failed", data: { reason, message, usage: { ...usage } } });
    return { status: "failed", reason, message, usage };
  };
  const complete = async (result: unknown): Promise<RunResult> => {
    state.ended = { status: "completed", output: result };
    await finalSave();
    await log.emit({
      type: "run.completed",
      data: { status: "completed", output: result, usage: { ...usage } },
    });
    return { status: "completed", output: result, usage };
  };

  // A run that already ended answers with its ending, and does nothing else: what a parent finds
  // when it resumes mid-call and starts the same child again.
  if (saved && state.ended) {
    const ended = state.ended;
    return ended.status === "failed"
      ? { status: "failed", reason: ended.reason, message: ended.message, usage }
      : ended.status === "rejected"
        ? { status: "rejected", output: ended.output, usage }
        : { status: "completed", output: ended.output, usage };
  }

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
        ...(opts.ctx.parent ? { parent: { ...opts.ctx.parent } } : {}),
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

    /**
     * Saves the run as waiting for a person and hands the host the questions (ADR 0029): the
     * model's, a tool's, a child run's, or the review of a write (`subject`). Returns the result
     * that ends this invocation when the answers come later, or the decision when the host
     * answered at once.
     */
    const askPerson = async (
      call: ToolCall,
      input: unknown,
      questions: AskedQuestion[],
      from: string[],
      subject?: Subject,
    ): Promise<{ ended: RunResult } | { decision: Decision }> => {
      const ids = { step, callId: call.id, tool: call.name };
      // this run's own questions say what they are about (ADR 0033); a child's already do
      if (from.length === 0) questions = questions.map((q) => withAbout(q, spec, state.situation));
      // what a person decided before goes into the proposals; and a question a house fact answers
      // is not asked again (a write's review is always asked)
      if (!subject && opts.learned) {
        questions = await opts.learned.refine(questions);
        const standing = await opts.learned.answer(questions);
        if (standing) {
          await log.emit({ type: "question.asked", data: { ...ids, questions, from } });
          return { decision: { by: FROM_MEMORY, answers: standing } };
        }
      }
      // Saved as waiting, and the wait registered, before the questions are announced: an answer
      // sent the moment the event is seen always finds the run waiting for it.
      state.waiting = { ...ids, input, questions, from, ...(subject ? { subject } : {}) };
      await save("waiting");
      const pending = steps.interrupt({
        step,
        call,
        tool: call.name,
        input,
        questions,
        from,
        ...(subject ? { subject } : {}),
      });
      // a host can fail before the questions are announced; that error is raised by the await below
      pending.catch(() => {});
      await log.emit({
        type: "question.asked",
        data: { ...ids, questions, from, ...(subject ? { subject } : {}) },
      });
      const got = await pending;
      if ("pending" in got) {
        await save("waiting");
        return { ended: { status: "waiting", waiting: state.waiting, usage } };
      }
      return { decision: got };
    };

    /**
     * What the person answered: their answers (a question left out is skipped; with no answers at
     * all each proposal is used), the change they asked for on a write, or the end of the run when
     * they rejected a write. A pause for questions is never ended by the person: only cancelling
     * the run ends it, and that is the host's own call.
     */
    const settle = async (
      call: ToolCall,
      input: unknown,
      questions: AskedQuestion[],
      got: Decision,
    ): Promise<
      { by: string; answers: Answers } | { changes: string; by: string } | { ended: RunResult }
    > => {
      const ids = { step, callId: call.id, tool: call.name };
      state.waiting = undefined;
      const review = questions.some((q) => q.kind === "review");
      const answers = got.answers ?? (review ? {} : proposedAnswers(questions));
      await log.emit({
        type: "question.answered",
        data: {
          ...ids,
          by: got.by,
          answers,
          source:
            got.by === FROM_MEMORY
              ? "memory"
              : got.by.endsWith(AUTO_APPROVED)
                ? "auto"
                : got.answers === undefined && !review
                  ? "agent"
                  : "person",
        },
      });
      if (!review) {
        await save("decision");
        return { by: got.by, answers };
      }
      // a write waits for an explicit answer: no answer is not a yes
      const verdict = answers[REVIEW_ID] as ReviewAnswer | undefined;
      if (verdict?.decision === "change") {
        const changes = verdict.comment?.trim();
        if (!changes) {
          throw new Error(`the responder sent ${call.name} back with an empty change request`);
        }
        await save("decision");
        return { changes, by: got.by };
      }
      if (verdict?.decision !== "approve") {
        const reason = verdict?.comment?.trim() || "no decision was made";
        const rejected = { tool: call.name, input, by: got.by, reason };
        state.ended = { status: "rejected", output: rejected };
        await save("decision");
        await log.emit({
          type: "run.completed",
          data: { status: "rejected", output: rejected, usage: { ...usage } },
        });
        return { ended: { status: "rejected", output: rejected, usage } };
      }
      // approved: the caller records it on the turn and saves, so a crash cannot lose the yes
      return { by: got.by, answers };
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
      if (call.name === ASK_TOOL) {
        const waited = state.waiting?.callId === call.id ? state.waiting : undefined;
        let questions = waited?.questions;
        if (!questions) {
          const parsed = parseAsk(call);
          if (!parsed.ok) {
            await skip(call.id, call.name, parsed.error, `Not asked: ${parsed.error}`);
            await save("tool");
            continue;
          }
          questions = parsed.questions;
        }
        let got: Decision;
        if (decision && waited) {
          got = decision;
          decision = undefined;
        } else {
          const asked = await askPerson(call, { questions }, questions, []);
          if ("ended" in asked) return asked.ended;
          got = asked.decision;
        }
        const settled = await settle(call, { questions }, questions, got);
        if ("ended" in settled) return settled.ended;
        if ("changes" in settled) throw new Error("a question was answered as a review");
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: answersText(questions, settled),
        });
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
          const refusal = hooks.beforeFinal({ value, ctx: opts.ctx, messages });
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
        // One refusal is feedback. The same call again is the model stuck, so a hook stops the
        // run instead of spending the rest of its steps on copies.
        const stop = hooks.afterTool({
          stage: "denied",
          reason: checked.reason,
          ...(checked.advisory ? { advisory: true } : {}),
          step,
          call,
          args: stableArgs(call.arguments),
        });
        if (stop !== undefined) {
          await log.emit({
            type: "tool.denied",
            data: { ...ids, stage: checked.stage, reason: stop },
          });
          messages.push({ role: "tool", toolCallId: call.id, content: stop, isError: true });
          await save("tool");
          return fail("invalid_output", stop);
        }
        await log.emit({
          type: "tool.denied",
          data: {
            ...ids,
            stage: checked.stage,
            reason: checked.reason,
            ...(checked.advisory ? { advisory: true } : {}),
          },
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
      hooks.afterTool({
        stage: "cleared",
        step,
        call,
        args: stableArgs(call.arguments),
      });

      // The call stopped the run with questions (a tool's own, or a child run's) and the answers
      // came: it runs again with them, already approved and already started. A write waiting for
      // a yes is the same pause with a review question, and goes on below.
      let withAnswers: { by: string; answers: Answers } | undefined;
      const waitedHere = state.waiting?.callId === call.id ? state.waiting : undefined;
      if (decision && waitedHere && !waitedHere.subject) {
        const settled = await settle(call, checked.input, waitedHere.questions, decision);
        decision = undefined;
        if ("ended" in settled) return settled.ended;
        if ("changes" in settled) throw new Error("a question was answered as a review");
        withAnswers = settled;
      }

      // approved before a crash: the reviewer is not asked twice
      if (checked.needsApproval && !turn.approved.includes(call.id) && !withAnswers) {
        const review = [reviewQuestion(call.name)];
        let got: Decision;
        if (decision && state.waiting?.callId === call.id) {
          got = decision;
          decision = undefined;
        } else {
          const asked = await askPerson(call, checked.input, review, [], { input: checked.input });
          if ("ended" in asked) return asked.ended;
          got = asked.decision;
        }
        const settled = await settle(call, checked.input, review, got);
        if ("ended" in settled) return settled.ended;
        if ("changes" in settled) {
          state.pendingChanges[call.name] = settled.changes;
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
        turn.approved.push(call.id);
        if (call.name in state.pendingChanges) {
          delete state.pendingChanges[call.name];
          state.blockedFinishes = 0;
        }
        await save("decision");
      }

      // Started before a crash and never answered: run it again only if that is safe.
      if (withAnswers) {
        // it stopped cleanly to ask, so running it again is how it goes on
      } else if (turn.started.includes(call.id)) {
        const tool = registry.get(call.name);
        if (tool?.effect !== "read" && !tool?.retries && !tool?.resumable) {
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

      if (!withAnswers) {
        await log.emit({ type: "tool.started", data: { ...ids, input: checked.input } });
      }
      const started = Date.now();
      let outcome: ToolOutcome | undefined;
      // A tool, or a child run, may stop to ask a person: it runs again with the answers.
      while (!outcome) {
        try {
          outcome = await steps.tool({
            step,
            call,
            input: checked.input,
            usdLeft: Math.max(0, spec.budget.usdPerRun - usage.budgetCostUsd),
            ...(state.situation ? { situation: state.situation } : {}),
            ...(withAnswers ? { answered: withAnswers } : {}),
          });
        } catch (err) {
          if (!(err instanceof AwaitingAnswers)) throw err;
          const asked = await askPerson(call, checked.input, err.questions, err.from);
          if ("ended" in asked) return asked.ended;
          const settled = await settle(call, checked.input, err.questions, asked.decision);
          if ("ended" in settled) return settled.ended;
          if ("changes" in settled) throw new Error("a question was answered as a review");
          withAnswers = settled;
        }
      }
      const content = outcome.ok ? outcome.content : `Error: ${outcome.error}`;
      if (!outcome.ok) turn.failed = call.name;
      // a child run's spend is the run's spend: its tokens and dollars, not its turns
      if (outcome.usage) addSpend(usage, outcome.usage);
      // what the run works on, as the tool found it (ADR 0033): saved with the next save point
      if (outcome.situation) state.situation = outcome.situation;
      // the same call failing again and again is the model stuck, like a refused copy of it
      const stop = hooks.afterTool({
        stage: "ran",
        ok: outcome.ok,
        step,
        call,
        args: stableArgs(call.arguments),
      });
      await log.emit({
        type: "tool.completed",
        data: {
          ...ids,
          ok: outcome.ok,
          content,
          durationMs: Date.now() - started,
          ...(outcome.usage ? { usage: { ...outcome.usage } } : {}),
        },
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content,
        ...(outcome.ok ? {} : { isError: true }),
      });
      if (outcome.ok && registry.get(call.name)?.effect === "write") state.wrote = true;
      await save("tool");
      // a sign-in or a key is missing: the run waits on a person setting it up, not on the model
      if (outcome.setup !== undefined) return fail("error", `${NEEDS_SETUP} ${outcome.setup}`);
      if (stop !== undefined) return fail("invalid_output", stop);
      if (usage.budgetCostUsd > spec.budget.usdPerRun) {
        return fail(
          "budget",
          `spent $${usage.budgetCostUsd.toFixed(4)} of $${spec.budget.usdPerRun} budget`,
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
        const step = state.step + 1;
        if (opts.compaction) {
          const { summarizer, ...rest } = opts.compaction;
          let summarizedBy: string | undefined;
          const done = await compact(messages, state, tools, {
            ...rest,
            summarize: async (prompt) => {
              try {
                const turn = await steps.model({
                  step,
                  model: summarizer,
                  messages: [
                    { role: "system", content: SUMMARY_SYSTEM },
                    { role: "user", content: prompt },
                  ],
                  tools: [],
                  quiet: true,
                });
                addUsage(usage, turn.usage);
                usage.steps -= 1; // spend, but not one of the run's steps
                const text = turn.message.content.trim();
                if (text) summarizedBy = summarizer;
                return text || undefined;
              } catch (err) {
                // a summary that cannot be written is not worth the run
                if (err instanceof RunInterrupted) throw err;
                return undefined;
              }
            },
          });
          if (done) {
            await log.emit({
              type: "context.compacted",
              data: { step, ...done, ...(summarizedBy ? { summarizer: summarizedBy } : {}) },
            });
            await save("model");
          }
        }
        const before = hooks.beforeModel(
          { step, maxSteps: spec.budget.maxSteps, hasOutput: output !== undefined },
          compactedView(messages, state.compacted),
        );
        if (before.append.length > 0) {
          messages.push(...before.append);
          await save("model");
        }
        // the last step, and the turn after a nudge, must end the run
        const last = messages.at(-1);
        const forceFinal =
          output !== undefined &&
          // A model forced to answer before it saved ends "completed" with nothing saved.
          (state.wrote || !writeExpected) &&
          (step >= spec.budget.maxSteps ||
            (last?.role === "user" && last.content.startsWith(FINAL_NUDGE)));
        const turn = await steps.model({
          step,
          model: spec.model,
          messages: before.view,
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

        // what to say to a turn that made no tool call comes from the hooks; the limits stay here
        const nudge =
          hooks.afterModel({
            step,
            hasOutput: output !== undefined,
            finishReason: turn.finishReason,
            cutOff,
            toolCalls: turn.message.toolCalls?.length ?? 0,
            pendingChanges: state.pendingChanges,
          }) ?? FINAL_NUDGE;

        if (!turn.message.toolCalls?.length) {
          if (cutOff) {
            messages.push({ role: "user", content: nudge });
          } else if (hasPendingChanges()) {
            if (++state.blockedFinishes > MAX_INVALID_OUTPUTS)
              return fail("invalid_output", UNMADE);
            messages.push({ role: "user", content: nudge });
          } else if (!output) {
            return complete(turn.message.content);
          } else {
            if (++state.invalidOutputs > MAX_INVALID_OUTPUTS) {
              // what it said instead is the reason: a question for a person, usually
              const said = turn.message.content.trim().replace(/\s+/g, " ");
              return fail(
                "invalid_output",
                `ended without calling ${FINAL_TOOL}${said ? `: ${said.length > 600 ? `${said.slice(0, 599)}…` : said}` : ""}`,
              );
            }
            messages.push({ role: "user", content: nudge });
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
  if ((spec.agents?.length ?? 0) > 0 && spec.budget.maxDepth < 1) {
    throw new SpecError(`${spec.id}: calls agents, so budget.maxDepth must be 1 or more`);
  }
  for (const name of spec.tools) {
    if (name === FINAL_TOOL || name === ASK_TOOL) {
      throw new SpecError(`${spec.id}: ${name} is reserved`);
    }
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

function parseAsk(
  call: ToolCall,
): { ok: true; questions: Question[] } | { ok: false; error: string } {
  let args: unknown;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
  const parsed = AskInput.safeParse(args);
  return parsed.success
    ? { ok: true, questions: parsed.data.questions }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/** The answers as the model reads them: each question with what the person said. */
function answersText(
  questions: AskedQuestion[],
  { by, answers }: { by: string; answers: Answers },
) {
  return JSON.stringify({
    answeredBy: by,
    answers: questions.map((q) => ({
      id: q.id,
      question: q.question,
      answer: q.id in answers ? answers[q.id] : null,
    })),
    ...(questions.some((q) => !(q.id in answers))
      ? { note: "A null answer was left open: decide it yourself, and say so in your result." }
      : {}),
  });
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

/** Adds what a tool call spent (a child run) to the run's usage. Its turns are the child's own. */
function addSpend(total: RunUsage, spent: RunUsage): void {
  total.inputTokens += spent.inputTokens;
  total.cachedInputTokens += spent.cachedInputTokens;
  total.cacheWriteInputTokens += spent.cacheWriteInputTokens;
  total.outputTokens += spent.outputTokens;
  total.reasoningTokens += spent.reasoningTokens;
  total.costUsd += spent.costUsd;
  total.budgetCostUsd += spent.budgetCostUsd;
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

/**
 * `ask`'s description: what to ask and how, and the questions the agent declares (ADR 0033), so the
 * same question has the same id every time and what a person answers is learned.
 */
function askDescription(spec: AgentSpec): string {
  const declared = Object.entries(spec.questions ?? {});
  if (declared.length === 0) return ASK_DESCRIPTION;
  const list = declared.map(([id, q]) => `${id} (${q.about})`).join("; ");
  return `${ASK_DESCRIPTION} When a question is one of these, use its id, so what the person answers is remembered: ${list}. Any other id is asked all the same and not remembered.`;
}

/** A declared question of this run's, with what it is about (ADR 0033); others as they are. */
export function withAbout(
  q: AskedQuestion,
  spec: AgentSpec,
  situation: RunCheckpoint["situation"],
): AskedQuestion {
  const declared = q.kind === "review" ? undefined : spec.questions?.[q.id];
  if (!declared || q.about) return q;
  return {
    ...q,
    about: {
      agent: spec.id,
      scope: declared.scope,
      ...(declared.fact ? { fact: declared.fact } : {}),
      ...(situation ? { section: situation.section } : {}),
      ...(situation?.name ? { name: situation.name } : {}),
    },
  };
}
