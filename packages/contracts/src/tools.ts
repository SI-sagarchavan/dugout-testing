import type { z } from "zod";
import type { RunEvent, RunUsage } from "./events.ts";
import type { Answers } from "./questions.ts";
import type { Situation } from "./runtime.ts";

/** Built from the run's verified context, never from model output. */
export interface ToolContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  /** The host's parsed run input, when the run has one. Never taken from the model. */
  readonly input?: unknown;
  /** The call being answered. A child run's id is derived from it, so a retry finds the same child. */
  readonly callId?: string;
  /** How many runs this one is below the run a host started: 0 there, 1 in its child. */
  readonly depth?: number;
  /** What the run has left of its budget when the call starts, in budget dollars. */
  readonly usdLeft?: number;
  /** Counts what the call spent (a child run's model calls) against the run's budget. */
  spend?(usage: RunUsage): void;
  /**
   * The person's answers, when this call stopped the run with questions (`AwaitingAnswers`) and
   * runs again now that they came (ADR 0029). A child run waiting on them resumes with them.
   */
  /** `from`: the child runs the questions came from, nearest first; none when the tool's own. */
  readonly answered?: {
    readonly by: string;
    readonly answers: Answers;
    readonly from?: readonly string[];
  };
  /**
   * Writes a child run's event to this run's stream, as the next of its events (ADR 0025): a
   * child started by this call is part of this run's invocation, not a stream of its own.
   */
  relay?(event: RunEvent): Promise<void>;
  /** What the run works on so far (ADR 0033): a child run started by this call inherits it. */
  readonly situation?: Situation;
  /**
   * Says what the run works on, from what the tool loaded (ADR 0033): the section by its tree's
   * structural signature. A person's answers to the run's section questions are about it.
   */
  situate?(situation: Situation): void;
}

export interface Tool<I = unknown, O = unknown, R = I> {
  /** Dotted lower camel case, e.g. `fixtures.get`. */
  name: string;
  description: string;
  input: z.ZodType<I>;
  effect: "read" | "write";
  timeoutMs: number;
  /** Extra attempts after a failure or timeout. Defaults to 0; only safe for idempotent tools. */
  retries?: number;
  /**
   * Safe to run again when a crash cut a call short, though it writes: it carries on from where it
   * was instead of doing it twice (a child run, which resumes from its save). Without it, a write
   * the run cannot tell finished is reported as an unknown outcome and not run again.
   */
  resumable?: boolean;
  /** Writes, but starts without asking: only the questions it raises reach a person. */
  noApproval?: boolean;
  /** Output is never swapped for a reference, however long: the model needs all of it (a skill). */
  alwaysInline?: boolean;
  /**
   * Replaces the parsed arguments before the gate and the approval. The model still sees `input`.
   * Use it when the host already holds the payload and the model must not send it back.
   */
  resolve?(input: I, ctx: Pick<ToolContext, "tenantId" | "runId" | "input">): R;
  /**
   * Sync check after the schema and before approval. A string denies the call.
   * Use it for a gate that needs the verified run input, such as a file the host named.
   */
  block?(input: R, ctx: Pick<ToolContext, "tenantId" | "runId" | "input">): string | undefined;
  /**
   * What `block` says is advice for a step the run is working towards (the tool is not ready until
   * something else is done), not a sign the model is stuck: the same call again after it does not
   * end the run. The gate must bound itself, so the run still ends: it lets the call through after
   * so many refusals.
   */
  advisoryBlock?: boolean;
  run(input: R, ctx: ToolContext): Promise<O>;
}

export function defineTool<I, O, R = I>(tool: Tool<I, O, R>): Tool<I, O, R> {
  return tool;
}

/** `usage` is what the call spent besides the run's own model turns: a child run's. */
export type ToolOutcome = ({ ok: true; content: string } | { ok: false; error: string }) & {
  usage?: RunUsage;
  /** The tool cannot go on until a person sets this up (`NeedsSetup`): the run ends. */
  setup?: string;
  /** What the run works on, when the call said (`ToolContext.situate`). */
  situation?: Situation;
};

export type DenialStage = "registry" | "spec" | "policy";

/** What a run that stopped for setup says, first: how a parent knows not to try it again. */
export const NEEDS_SETUP = "needs setup:";

/**
 * A tool cannot go on until a person sets something up: a sign-in to a server, a key, a config.
 * Trying again changes nothing, so the run ends at once, failed with `needs setup: <what>`, and a
 * parent that started it does not try it again: it ends the same way, so the person who started the
 * whole run reads what to set up rather than three failures of the same thing.
 */
export class NeedsSetup extends Error {
  readonly setup: string;
  constructor(setup: string) {
    super(setup);
    this.name = "NeedsSetup";
    this.setup = setup;
  }
}

/** A `NeedsSetup`, from this realm or another copy of this package. */
export const isNeedsSetup = (err: unknown): err is NeedsSetup =>
  err instanceof NeedsSetup ||
  (err instanceof Error && err.name === "NeedsSetup" && "setup" in err);
