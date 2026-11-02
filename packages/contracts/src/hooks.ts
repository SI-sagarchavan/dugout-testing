import type { Message, ToolCall } from "./messages.ts";
import type { RunContext } from "./runtime.ts";

/**
 * Per-turn rules of a run (ADR 0023). A hook is a plain object of optional functions the loop calls
 * at fixed points. They are pure and synchronous: no I/O, no clock, no randomness. A rule that
 * needs any of those is a tool or a step. The same checkpoint and transcript must give the same
 * answer on a resume or a fork, so a hook's memory is its `state`, which the loop saves in the
 * checkpoint (`hooks[id]`), never a variable in the hook.
 *
 * Each function returns `undefined` for "nothing to do", or an outcome. `state` in an outcome
 * replaces the hook's state; leave it out to keep it. State must be JSON.
 */
export interface RunHook<S = unknown> {
  /** Names the hook's state in the checkpoint, and the hook in an error. Unique in a run. */
  id: string;
  /** The state a run starts with. Without it a hook starts with `undefined`. */
  initial?: S;
  /** Before each model call. */
  beforeModel?(event: BeforeModel, state: S): BeforeModelOutcome<S> | undefined;
  /** After a model turn, before its tool calls (if any) are answered. */
  afterModel?(event: AfterModel, state: S): AfterModelOutcome<S> | undefined;
  /** After a tool call was refused, cleared to run, or ran. */
  afterTool?(event: AfterTool, state: S): AfterToolOutcome<S> | undefined;
  /** On a valid `final`, before the run ends with it. */
  beforeFinal?(event: BeforeFinal, state: S): BeforeFinalOutcome<S> | undefined;
}

/** Hooks are typed by their own state; a list of them holds any. */
export function defineHook<S>(hook: RunHook<S>): RunHook {
  return hook as RunHook;
}

export interface BeforeModel {
  /** The turn about to be taken, counting from 1. */
  step: number;
  maxSteps: number;
  /** The agent ends with a validated `final`. */
  hasOutput: boolean;
  /** What will be sent: the transcript, or the view an earlier hook made of it. */
  messages: readonly Message[];
}
export interface BeforeModelOutcome<S> {
  state?: S;
  /** Added to the transcript, saved, and sent. */
  append?: Message[];
  /** Sent instead of the messages. The saved transcript is not touched. */
  view?: Message[];
}

export interface AfterModel {
  step: number;
  hasOutput: boolean;
  finishReason: string;
  /** The reply was cut off, so its calls (if any) do not run. */
  cutOff: boolean;
  toolCalls: number;
  /** Change requests the reviewer made that are not yet approved, by tool. */
  pendingChanges: Readonly<Record<string, string>>;
}
export interface AfterModelOutcome<S> {
  state?: S;
  /** Added to the transcript as a user message, when the turn made no tool calls. */
  nudge?: string;
}

export type AfterToolStage =
  | { stage: "denied"; reason: string }
  /** The call passed the checks before it. It may still wait for an approval. */
  | { stage: "cleared" }
  | { stage: "ran"; ok: boolean };
export type AfterTool = AfterToolStage & {
  step: number;
  call: ToolCall;
  /** The call's arguments with key order normalised, so two copies compare equal. */
  args: string;
};
export interface AfterToolOutcome<S> {
  state?: S;
  /** Ends the run: `invalid_output`, with this message. */
  stop?: string;
}

export interface BeforeFinal {
  /** The unwrapped, completed value. */
  value: unknown;
  ctx: RunContext;
  messages: readonly Message[];
}
export interface BeforeFinalOutcome<S> {
  state?: S;
  /** Refuses the `final` call. This goes back to the model as the reason. */
  refuse?: string;
}
