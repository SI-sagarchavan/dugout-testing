import { z } from "zod";
import { RunUsage } from "./events.ts";
import type { Message, ToolCall } from "./messages.ts";
import type { ModelTurn, StepUsage, ToolDefinition } from "./model.ts";
import {
  type Answers,
  AskedQuestion,
  type Decision,
  reviewQuestion,
  Subject,
} from "./questions.ts";
import { Situation } from "./situation.ts";
import type { StateValues } from "./state.ts";
import type { ToolOutcome } from "./tools.ts";

/** Verified identity for one run. Built by the caller (CLI now, API later), never by the model. */
export interface RunContext {
  readonly runId: string;
  readonly tenantId: string;
  /** The host's parsed run input. Tools may read it. The model cannot change it. */
  readonly input?: unknown;
  /** 0, or unset, for a run a host started; a child run is one below the run that called it. */
  readonly depth?: number;
  /** A child run's parent: the run and the call that started it. */
  readonly parent?: { readonly runId: string; readonly callId: string };
  /** What the run works on when it starts: a child's is its parent's at the call (ADR 0033). */
  readonly situation?: Situation;
  /** A child run's input as its parent hashed it; kept on the run's save points. */
  readonly inputHash?: string;
}

/**
 * Memory and skills assembled for a run. `text` is stable instructions-level material, appended to
 * the agent's instructions. `recalled` depends on the run's input (lessons, approved examples, the
 * date) and goes ahead of the input in the first user message; empty when there is none.
 */
export interface RunMemoryContext {
  text: string;
  recalled: string;
  tokens: number;
  sources: Array<{ id: string; kind: string; tokens: number; text?: string }>;
}

export interface ModelStepRequest {
  step: number;
  /** A name in the model list. */
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** Ask the model to call this tool; dropped for a model that can't be forced. */
  toolChoice?: { tool: string };
  /** Not part of the run's turns: its text is not streamed to the event log. */
  quiet?: boolean;
}

export type ModelStep = ModelTurn & { usage: StepUsage };

export interface ToolStepRequest {
  step: number;
  call: ToolCall;
  /** Already parsed and validated by preflight. */
  input: unknown;
  /** What the run has left of its budget, in budget dollars. A child run gets no more. */
  usdLeft?: number;
  /** The answers this call stopped the run for, when it runs again with them (ADR 0029). */
  /** `from`: the child runs the questions came from, nearest first; none for the tool's own. */
  answered?: { by: string; answers: Answers; from?: string[] };
  /** What the run works on so far (ADR 0033). */
  situation?: Situation;
  /** The run's state when the call starts (ADR 0035). */
  state?: StateValues;
}

/**
 * A run stopping for a person (ADR 0029): the questions to answer, the runs they came from, and the
 * call they are about when it is a write waiting for a yes.
 */
export interface InterruptRequest {
  step: number;
  call: ToolCall;
  tool: string;
  input: unknown;
  questions: AskedQuestion[];
  /** The runs the questions came from, nearest first: empty when this run asked them. */
  from: string[];
  /** Set when the pause is a write waiting for a yes: one `review` question, and this call. */
  subject?: Subject;
}

/** No decision yet: the run saves its state and ends, and the decision resumes it later. */
export interface InterruptPending {
  pending: true;
}

/** What a save point comes right after. Every one is kept, so a run can be forked from it. */
export const SavedAfter = z.enum([
  "start", // the run's instructions and input
  "model", // a model turn
  "call", // a call about to run
  "tool", // a call's result, or why it didn't run
  "waiting", // a pause for a person: questions, or a write waiting for a yes
  "decision", // a person's answers
  "end", // the run's last save
  "fork", // a fork's copy of its parent's save point
]);
export type SavedAfter = z.infer<typeof SavedAfter>;

/**
 * Where a run is, saved after every change so a later invocation (after an approval, or after a
 * crash) carries on from here. The transcript is saved beside it, append-only.
 */
/** A `waiting` saved before questions existed was a write waiting for a yes. */
function upgradeWaiting(value: unknown): unknown {
  if (typeof value !== "object" || value === null || "questions" in value) return value;
  const old = value as { tool?: string; input?: unknown };
  return {
    ...value,
    questions: [reviewQuestion(old.tool ?? "this call")],
    from: [],
    subject: { input: old.input },
  };
}

export const RunCheckpoint = z.object({
  version: z.literal(1),
  agentId: z.string(),
  agentVersion: z.number(),
  /** Model turns taken so far. */
  step: z.number().int().nonnegative(),
  usage: RunUsage,
  /** Transcript messages saved so far. */
  messages: z.number().int().nonnegative(),
  /** `seq` of the last event emitted before this was saved. */
  lastSeq: z.number().int().nonnegative(),
  invalidOutputs: z.number().int().nonnegative(),
  blockedFinishes: z.number().int().nonnegative(),
  /** A tool that writes has completed in this run. Absent on a run saved before this existed. */
  wrote: z.boolean().default(false),
  /** @deprecated Now `hooks.repeatedCalls`; read only, to carry a saved run over. */
  refused: z.object({ tool: z.string(), args: z.string() }).optional(),
  /** @deprecated Now `hooks.repeatedCalls`; read only, to carry a saved run over. */
  failedCall: z
    .object({ tool: z.string(), args: z.string(), count: z.number().int().positive() })
    .optional(),
  /** @deprecated Now `hooks.stepsLeft`; read only, to carry a saved run over. */
  stepsWarned: z.boolean().optional(),
  /** Each hook's state by hook id (ADR 0023). Absent on a run saved before hooks. */
  hooks: z.record(z.string(), z.unknown()).optional(),
  /** Change requests not yet approved, by tool. */
  pendingChanges: z.record(z.string(), z.string()),
  /** Set while the calls of the last assistant message are being answered. */
  turn: z
    .object({
      changesRequested: z.boolean(),
      remind: z.boolean(),
      /** Calls the reviewer approved, so a resumed run does not ask again. */
      approved: z.array(z.string()),
      /** Calls whose tool started; after a crash only retry-safe tools run again. */
      started: z.array(z.string()),
      /** A call in this turn was denied, failed or has an unknown outcome: the tool's name. */
      failed: z.string().optional(),
      /** The reply was cut off, so none of its calls run. */
      cutOff: z.boolean().optional(),
      /** The stop reason that cut it off, for the tool results a resumed run still owes. */
      cutOffReason: z.string().optional(),
    })
    .optional(),
  /**
   * What the run is stopped for: the questions a person answers (ADR 0029). A checkpoint saved
   * while a write waited for a yes, before questions existed, is read as the review it was.
   */
  waiting: z
    .preprocess(
      upgradeWaiting,
      z.object({
        step: z.number(),
        callId: z.string(),
        tool: z.string(),
        input: z.unknown(),
        questions: z.array(AskedQuestion),
        /** The runs the questions came from, nearest first: empty when this run asked them. */
        from: z.array(z.string()),
        /** Set for a write waiting for a yes: the call under review. */
        subject: Subject.optional(),
      }),
    )
    .optional(),
  /**
   * How the transcript is made smaller for the model (ticket thread-context/02): tool results
   * replaced by a reference (`elided`, by call id) and, when that was not enough, the messages
   * from the third to `upTo` replaced by `summary`. The transcript itself is never rewritten.
   */
  compacted: z
    .object({
      upTo: z.number().int().nonnegative(),
      summary: z.string().optional(),
      elided: z.record(z.string(), z.string()),
    })
    .optional(),
  /** What the run works on, once a tool said (ADR 0033). Absent before, and on older saves. */
  situation: Situation.optional(),
  /**
   * The run's state (ADR 0035): what its tools kept, by key name. Absent until a tool keeps
   * something, and on older saves.
   */
  state: z.record(z.string(), z.unknown()).optional(),
  /**
   * A child run's input, as its parent hashed it (`inputKey`): a writing child is built once for
   * each input, and a restarted parent finds the try for this input by it (ADR 0025).
   */
  inputHash: z.string().optional(),
  /**
   * A child run's: the parent's call that started it. A restarted parent tells the call a crash
   * cut short (its own try) from a later call asking the same again (ADR 0025).
   */
  parentCallId: z.string().optional(),
  /** Unset on checkpoints saved before save points were kept. */
  savedAfter: SavedAfter.optional(),
  /** The run and save point this run was forked from. */
  forkedFrom: z.object({ runId: z.string(), version: z.number().int().positive() }).optional(),
  /**
   * How the run ended, on its last save. A run resumed after it ended returns this instead of
   * going on: a parent resumed mid-call finds its child's answer here. Absent before it ended.
   */
  ended: z
    .discriminatedUnion("status", [
      z.object({ status: z.literal("completed"), output: z.unknown() }),
      z.object({
        status: z.literal("rejected"),
        output: z.object({
          tool: z.string(),
          input: z.unknown(),
          by: z.string(),
          reason: z.string(),
        }),
      }),
      z.object({
        status: z.literal("failed"),
        reason: z.enum(["budget", "max_steps", "invalid_output", "model_stop", "error"]),
        message: z.string(),
      }),
    ])
    .optional(),
});
export type RunCheckpoint = z.infer<typeof RunCheckpoint>;

/** A run's working memory as saved: its checkpoint and its transcript. */
export interface SavedRun {
  checkpoint: RunCheckpoint;
  messages: Message[];
}

/** One save point of a run, as its history lists it. */
export interface SavePoint {
  /** 1 for the run's first save, counting up. */
  version: number;
  step: number;
  savedAfter: SavedAfter | undefined;
  /** Transcript messages at this point. */
  messages: number;
  /** The call it waited for a decision on, if it did. */
  waiting?: { callId: string; tool: string };
  savedAt: string;
}

/**
 * Keeps runs' working memory between invocations. The transcript only grows, so any save point's
 * transcript is the first `checkpoint.messages` of it.
 */
export interface RunStore {
  /** The latest save point, or the one `version` names. */
  load(ctx: RunContext, version?: number): Promise<SavedRun | undefined>;
  /** Appends `messages` to the transcript and saves the checkpoint as a new save point, in one write. */
  save(ctx: RunContext, checkpoint: RunCheckpoint, messages: Message[]): Promise<void>;
  /** Every save point kept, oldest first. */
  history(ctx: RunContext): Promise<SavePoint[]>;
}

/**
 * Everything the loop does that touches the outside world. In-process it calls functions directly;
 * under Temporal each method becomes an activity (model, tool) or a signal wait (a person's answers).
 */
export interface Steps {
  model(req: ModelStepRequest): Promise<ModelStep>;
  tool(req: ToolStepRequest): Promise<ToolOutcome>;
  interrupt(req: InterruptRequest): Promise<Decision | InterruptPending>;
  /** Saves the run's state; without it the run cannot outlive this invocation. */
  checkpoint?(checkpoint: RunCheckpoint, appended: Message[]): Promise<void>;
}
