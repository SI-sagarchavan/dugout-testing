import { createHash } from "node:crypto";
import {
  type AgentSpec,
  type Answers,
  AUTO_APPROVED,
  AwaitingAnswers,
  approve,
  type ChildRef,
  defineTool,
  type EventSink,
  NEEDS_SETUP,
  NeedsSetup,
  type RunCheckpoint,
  reject,
  type Tool,
  type ToolContext,
} from "@dugout/contracts";
import type { Responder } from "@dugout/core";
import { z } from "zod";
import type { AgentResult, AnyAgent, RunOptions } from "./agent.ts";

/** A child run can take this long, model turns included, before its parent's call gives up. */
export const CHILD_TIMEOUT_MS = 15 * 60_000;

/**
 * How a host keeps a child run's record (ADR 0025). The worker gives each child a `runs` row of
 * its own, linked to the parent and never claimed on its own, so its events and save points have
 * somewhere to go. Without one (tests, evals) the child keeps only what the parent's store keeps.
 */
export interface ChildRuns {
  /**
   * Records the child before it runs, or takes the record over again when the parent resumes
   * mid-call. Returns the last `seq` the child's events already have.
   */
  open(child: {
    runId: string;
    agentId: string;
    input: unknown;
    parent: { runId: string; callId: string };
  }): Promise<{ lastSeq: number }>;
}

/** `hook-maker` is called as `agent.hookMaker`. */
export function agentToolName(agentId: string): string {
  const camel = agentId.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  return `agent.${camel.charAt(0).toLowerCase()}${camel.slice(1)}`;
}

/**
 * The child's run id, from the parent run and the call: a parent resumed mid-call starts the
 * same child again, which finds its own save points and carries on (or answers, if it ended).
 */
export function childRunId(parentRunId: string, callId: string): string {
  const hex = createHash("sha1").update(`${parentRunId}\0${callId}`).digest("hex");
  // laid out as a version 5 UUID, so hosts that expect run ids to be UUIDs take it
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A child that reads is never asked; a write reaching here is refused. */
const refuseWrites: Responder = async (req) =>
  reject("harness", `${req.tool} writes, and this child run may not write`);

/**
 * A child that writes was approved as a whole: the parent's call to it was the write a person
 * said yes to. Its own writes go through under that approval, and say so. What it may write is
 * bounded by its own tools (hook-maker writes only the one hook it creates).
 */
const approvedWithCall =
  (
    parent: { runId: string; callId: string },
    /** Whether this tenant let writes to shared things go through under a parent's yes. */
    sharedAuto: () => Promise<boolean>,
  ): Responder =>
  async (req) => {
    // A write to something others use is a person's yes, not the parent call's: it waits (ADR 0029)
    // unless the tenant opted in with the house fact `approvals.shared-writes: auto`.
    if (req.questions.some((q) => q.shared) && !(await sharedAuto())) return { pending: true };
    return approve(
      `the call that started this run (${parent.runId} ${parent.callId})${AUTO_APPROVED}`,
    );
  };

/** The house fact that lets a tenant's shared writes go through under one approval. */
export const SHARED_WRITES_FACT = "approvals.shared-writes";

/** The value of `approvals.shared-writes` that opts a tenant in; any other value, or none, does not. */
export const SHARED_WRITES_AUTO = "auto";

/**
 * Whether a tenant opted in to shared writes going through without a person's own yes: its active
 * house fact `approvals.shared-writes` has the typed value "auto" (`pnpm agent memory fact --key
 * approvals.shared-writes --value auto --approve "…"`). The sentence is for people and is never
 * read: "Shared writes are never auto-approved" does not opt in. `tenantId` is the verified run's.
 */
export async function sharedWritesAuto(
  facts: {
    activeFacts(tenantId: string): Promise<Array<{ key: string | null; value: unknown }>>;
  },
  tenantId: string,
): Promise<boolean> {
  return (await facts.activeFacts(tenantId)).some(
    (f) => f.key === SHARED_WRITES_FACT && f.value === SHARED_WRITES_AUTO,
  );
}

/**
 * A child's write waits for a yes that its parent's call already gave. Its questions are another
 * matter: a question waits for a person (ADR 0029). The child saves itself as waiting and its
 * parent's call stops with the questions, up to the run the host follows.
 */
const askingAPerson =
  (responder: Responder): Responder =>
  async (req) =>
    req.subject ? responder(req) : { pending: true };

type RunChild = (opts: RunOptions<never>) => Promise<AgentResult>;

/** What a writing child's run id is derived from, with its agent id, in place of a call id. */
const ONCE = "once:";

/**
 * How often a child that writes is tried in one parent run. A try that failed may be made again,
 * but each is a call a person approves (and sees why it is being asked again); past this many the
 * call is refused and the run says a person has to look. A try that completed is final.
 */
export const MAX_WRITING_ATTEMPTS = 3;

/**
 * How many tries a writing child has in one parent run (and key), whatever became of them: each
 * new need is a try a person approves, so a run that keeps changing the need still ends. Past this
 * many the call is refused and says a person has to look.
 */
export const MAX_WRITING_TRIES = 5;

/**
 * The run id of the n-th try of a writing child: the first keeps the id it always had. A call
 * with a `key` is a child of its own, one per key (a pipeline's several bindings, one per slot);
 * no key is the one-thing-per-run child it always was.
 */
const attemptId = (parentRunId: string, agentId: string, attempt: number, key?: string) => {
  const who = key === undefined ? agentId : `${agentId}@${key}`;
  return childRunId(parentRunId, attempt === 1 ? `${ONCE}${who}` : `${ONCE}${who}:${attempt}`);
};

/** What a person is shown on a repeat call to a writing child: which try this is, and the last failure. */
interface Retry {
  /** The agent that failed, when a pipeline runs several. */
  stage?: string;
  /** Which of its keyed calls, where it was called with keys. */
  key?: string;
  attempt: number;
  of: number;
  lastFailure: string;
}

/** A child's answer: its run and what it output. */
export interface ChildAnswer {
  runId: string;
  output: unknown;
  /** Set when this call was answered from a try that already completed for this same input. */
  again?: true;
}

/**
 * What a writing child was asked, as one string: the canonical JSON of its input (keys sorted),
 * without the `retry` note that is for the person. The same need asked twice has the same key.
 */
export function inputKey(input: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  const bare =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== "retry"))
      : input;
  return createHash("sha1")
    .update(JSON.stringify(canonical(bare)) ?? "undefined")
    .digest("hex");
}

/**
 * One child agent, as its parent calls it: starts its run, counts its spend, remembers a try that
 * completed (a writing child builds one thing per parent run) and how the tries that failed failed.
 * `agentTool` fronts one of these for the model; `pipelineTool` runs several in code. A crash
 * mid-call is safe to run again: the child carries on from its save.
 */
export interface ChildCaller {
  readonly child: AnyAgent;
  readonly writes: boolean;
  /**
   * One try, or the answer of the try that completed for this same input (`again`). Throws when
   * the child failed, when it failed `MAX_WRITING_ATTEMPTS` times, or when it was tried
   * `MAX_WRITING_TRIES` times in this parent run (and key).
   */
  call(input: unknown, ctx: ToolContext, opts?: CallOptions): Promise<ChildAnswer>;
  /** The latest try that completed for this parent run (and key), whatever it was asked. */
  completedFor(parentRunId: string, key?: string): ChildAnswer | undefined;
  /** The try that completed for exactly this input, if one did. */
  completedForInput(parentRunId: string, input: unknown, key?: string): ChildAnswer | undefined;
  failuresFor(parentRunId: string, key?: string): string[];
  /** How many tries this parent run (and key) has made, whatever became of them. */
  triesFor(parentRunId: string, key?: string): number;
  /**
   * The refusal for this call before a person is asked, or undefined: the same need answered by
   * an earlier call, or no tries left. `callId` is the call being checked: a call a crash cut short
   * is its own try, taken up again, not a repeat.
   */
  refusal(parentRunId: string, input: unknown, callId?: string, key?: string): string | undefined;
  /**
   * Reads a parent run's tries from the run store (a writing child's), so a restarted parent
   * refuses a repeat before anyone is asked to approve it. Without a store it does nothing.
   */
  load(parentRunId: string, tenantId: string): Promise<void>;
  /** The keys this parent run has called the child with. */
  keysFor(parentRunId: string): string[];
}

export interface CallOptions {
  /** Which of a pipeline's runs of one stage this is, where it runs several. */
  stage?: string;
  /**
   * Names this call among several to one writing child (a slot's name). Each key is a child of
   * its own: its own run, its own answer once completed, its own three tries.
   */
  key?: string;
}

/** A child run's sink: each of its events, written to the stream of the run that called it. */
function relayTo(
  relay: NonNullable<ToolContext["relay"]>,
  child: {
    runId: string;
    agentId: string;
    parentOf: { runId: string; callId: string };
    key?: string;
  },
): EventSink {
  const ref: ChildRef = {
    runId: child.runId,
    agentId: child.agentId,
    parentRunId: child.parentOf.runId,
    callId: child.parentOf.callId,
    ...(child.key !== undefined ? { key: child.key } : {}),
  };
  return { write: (event) => relay({ ...event, child: event.child ?? ref }) };
}

export function childCaller(
  parent: AgentSpec,
  child: AnyAgent,
  runChild: RunChild,
  run: Pick<RunOptions<unknown>, "sinks" | "store" | "children" | "model"> & {
    /** Reads whether a tenant lets shared writes through under a parent's approval. */
    sharedWrites?: (tenantId: string) => Promise<boolean>;
  },
  opts: { writes: boolean },
): ChildCaller {
  // a writing child's completed answers, and how each failed try failed, by parent run: this
  // invocation's memory (the store, when there is one, is what a restarted worker goes by)
  // (a call with a key is its own child: its memory is of the parent run and the key)
  // (a writing child builds one thing per input: a completed try answers only the same input)
  const completed = new Map<string, Map<string, Completed>>();
  const latest = new Map<string, ChildAnswer>();
  // tries made so far, whatever became of them: the next try's number, so its run id is its own
  const tried = new Map<string, number>();
  const failures = new Map<string, string[]>();
  const answered = new Map<string, AgentResult>();
  const keys = new Map<string, Set<string>>();
  const scope = (parentRunId: string, key?: string) =>
    key === undefined ? parentRunId : `${parentRunId}\0${key}`;
  const failedTries = (parentRunId: string, key?: string) =>
    failures.get(scope(parentRunId, key)) ?? [];
  const remember = (mine: string, hash: string, entry: Completed) => {
    const byInput = completed.get(mine) ?? new Map<string, Completed>();
    completed.set(mine, byInput.set(hash, entry));
    latest.set(mine, entry.answer);
  };
  const triedAt = (mine: string, attempt: number) =>
    tried.set(mine, Math.max(tried.get(mine) ?? 0, attempt));
  // the inputs whose try started and has not ended (it waits for a person, or a crash cut it short)
  const unfinished = new Map<string, Set<string>>();
  const unfinishedOf = (mine: string) => {
    const set = unfinished.get(mine) ?? new Set<string>();
    unfinished.set(mine, set);
    return set;
  };

  /** Every try of this parent run (and key) the store has, in order: a try has a save once it ran. */
  const savedTries = async (parentRunId: string, tenantId: string, key?: string) => {
    const tries: SavedTry[] = [];
    if (!run.store) return tries;
    for (let attempt = 1; ; attempt++) {
      const runId = attemptId(parentRunId, child.spec.id, attempt, key);
      const saved = await run.store.load({ runId, tenantId });
      if (!saved) return tries;
      const { inputHash, parentCallId, ended } = saved.checkpoint;
      tries.push({
        attempt,
        runId,
        ...(inputHash !== undefined ? { hash: inputHash } : {}),
        ...(parentCallId !== undefined ? { callId: parentCallId } : {}),
        ...(ended ? { ended } : {}),
      });
    }
  };
  /** What the store says of this parent run's tries, kept in this invocation's memory. */
  const absorb = (mine: string, tries: SavedTry[]) => {
    const ended: string[] = [];
    for (const t of tries) {
      if (!t.ended && t.hash !== undefined) unfinishedOf(mine).add(t.hash);
      if (t.ended?.status === "completed") {
        // a try saved before inputs were kept matches no input: it is never an answer to one
        if (t.hash !== undefined) {
          remember(mine, t.hash, {
            answer: { runId: t.runId, output: t.ended.output },
            ...(t.callId !== undefined ? { callId: t.callId } : {}),
          });
        }
      } else if (t.ended) {
        ended.push(
          t.ended.status === "failed"
            ? `${t.ended.reason}: ${t.ended.message}`
            : `rejected: ${t.ended.output.reason}`,
        );
      }
    }
    if (ended.length > (failures.get(mine) ?? []).length) failures.set(mine, ended);
    triedAt(mine, tries.length);
  };
  /** A completed try for this input that another call made: the same need asked again. */
  const answeredBefore = (mine: string, hash: string, callId?: string) => {
    const done = completed.get(mine)?.get(hash);
    return done && (callId === undefined || done.callId !== callId) ? done : undefined;
  };
  const outOfTries = (mine: string, key?: string) => {
    const failed = failures.get(mine) ?? [];
    if (failed.length >= MAX_WRITING_ATTEMPTS) {
      return needsAPerson(child, failed.length, failed.at(-1), key);
    }
    const n = tried.get(mine) ?? 0;
    return n >= MAX_WRITING_TRIES ? triedOut(child, n, key) : undefined;
  };

  return {
    child,
    writes: opts.writes,
    completedFor: (parentRunId, key) => latest.get(scope(parentRunId, key)),
    completedForInput: (parentRunId, input, key) =>
      completed.get(scope(parentRunId, key))?.get(inputKey(input))?.answer,
    failuresFor: failedTries,
    triesFor: (parentRunId, key) => tried.get(scope(parentRunId, key)) ?? 0,
    keysFor: (parentRunId) => [...(keys.get(parentRunId) ?? [])],
    refusal(parentRunId, input, callId, key) {
      const mine = scope(parentRunId, key);
      const done = answeredBefore(mine, inputKey(input), callId);
      if (done) return alreadyAnswered(child, done.answer.output);
      // this input's own try is taken up again, whatever is left: one that waits for a person,
      // or the call a crash cut short
      if (unfinished.get(mine)?.has(inputKey(input))) return undefined;
      if (callId !== undefined && completed.get(mine)?.get(inputKey(input))) return undefined;
      return outOfTries(mine, key);
    },
    async load(parentRunId, tenantId) {
      if (!opts.writes || !run.store) return;
      absorb(scope(parentRunId), await savedTries(parentRunId, tenantId));
    },
    async call(input, ctx, callOpts = {}) {
      const { stage, key } = callOpts;
      const mine = scope(ctx.runId, key);
      if (key !== undefined) keys.set(ctx.runId, (keys.get(ctx.runId) ?? new Set()).add(key));
      const hash = inputKey(input);
      // the tries the store has (a restarted worker has nothing else), each with what it was asked
      const tries = opts.writes ? await savedTries(ctx.runId, ctx.tenantId, key) : [];
      if (opts.writes) absorb(mine, tries);
      // the same need, answered by an earlier call: answered again, and said so; nothing is built
      const before = opts.writes ? answeredBefore(mine, hash, ctx.callId) : undefined;
      if (before) return { ...before.answer, again: true };
      const depth = (ctx.depth ?? 0) + 1;
      if (depth > parent.budget.maxDepth) {
        throw new Error(
          `${child.spec.id} would run ${depth} level(s) below the run a host started; ${parent.id} allows ${parent.budget.maxDepth}`,
        );
      }
      if (!ctx.callId) throw new Error(`${child.spec.id} needs the call id to name its run`);
      const usdPerRun = Math.min(child.spec.budget.usdPerRun, ctx.usdLeft ?? Infinity);
      if (usdPerRun <= 0) throw new Error(`no budget left to run ${child.spec.id}`);

      const parentOf = { runId: ctx.runId, callId: ctx.callId };
      // A child that writes builds one thing per input: its run id comes from the parent run, its
      // agent id and which try this is, not the call. A try is taken up again only for its own
      // input: this call's own, cut short by a crash, or one that never ended. Any other input is
      // a new try, the next number, a child of its own.
      // A child that reads runs per call (and per stage, where one call runs several).
      let attempt = 1;
      let runId = childRunId(
        ctx.runId,
        [ctx.callId, stage, key].filter((part) => part !== undefined && part !== "").join(":"),
      );
      if (opts.writes) {
        // this input's own try: one that never ended, or this call's own that a crash cut short
        const takenUp = tries.find(
          (t) =>
            t.hash === hash &&
            (!t.ended || (t.ended.status === "completed" && t.callId === ctx.callId)),
        );
        if (takenUp) attempt = takenUp.attempt;
        else {
          // this call's own answer, kept in memory (no store): it is the answer again
          const own = completed.get(mine)?.get(hash);
          if (own) return own.answer;
          const refused = outOfTries(mine, key);
          if (refused) throw new Error(refused);
          attempt = Math.max(tries.length, tried.get(mine) ?? 0) + 1;
        }
        runId = attemptId(ctx.runId, child.spec.id, attempt, key);
        triedAt(mine, attempt);
        unfinishedOf(mine).add(hash);
      }
      const childCtx = { runId, tenantId: ctx.tenantId };
      const opened = await run.children?.open({
        runId,
        agentId: child.spec.id,
        input,
        parent: parentOf,
      });
      const saved = await run.store?.load(childCtx);
      // the child stopped to ask a person, and the answers came down with this call
      // (several children may be waiting under one call: the answers are for the one they came from)
      const theirs = !ctx.answered?.from?.length || ctx.answered.from.includes(runId);
      const answering = theirs && saved?.checkpoint.waiting?.questions && ctx.answered;
      const earlier = answered.get(runId);
      const result =
        earlier ??
        (await runChild({
          tenantId: ctx.tenantId,
          input: input as never,
          responder: askingAPerson(
            opts.writes
              ? approvedWithCall(
                  parentOf,
                  async () => (await run.sharedWrites?.(ctx.tenantId)) === true,
                )
              : refuseWrites,
          ),
          runId,
          depth,
          parent: parentOf,
          // what it was asked, so a restarted parent finds the try for this input again
          ...(opts.writes ? { inputHash: hash } : {}),
          usdPerRun,
          // the child's questions are about what this run works on (ADR 0033)
          ...(ctx.situation ? { situation: ctx.situation } : {}),
          // a host that named the model for the run named it for the whole tree
          ...(run.model ? { model: run.model } : {}),
          // one stream per invocation: the child's events go to this run's stream, tagged as
          // the child's; a grandchild's come up through the child, keeping their own tag
          ...(ctx.relay
            ? {
                sinks: [
                  relayTo(ctx.relay, {
                    runId,
                    agentId: child.spec.id,
                    parentOf,
                    ...(key !== undefined ? { key } : {}),
                  }),
                ],
              }
            : run.sinks
              ? { sinks: run.sinks }
              : {}),
          ...(run.store ? { store: run.store } : {}),
          // the child's own children need their records too: without it a grandchild has no
          // `runs` row, and its first event breaks the foreign key on `run_events`
          ...(run.children ? { children: run.children } : {}),
          ...(saved
            ? {
                resume: {
                  ...(answering
                    ? { reason: "answered" as const, decision: answering }
                    : { reason: "recovery" as const }),
                  ...(opened ? { startSeq: opened.lastSeq } : {}),
                },
              }
            : {}),
        }));
      // A child waiting on a person stops this call with its questions, up to the run the host
      // follows. Its spend so far is counted when it ends: its usage carries on from its save.
      if (result.status === "waiting") {
        const { questions, from } = result.waiting;
        throw new AwaitingAnswers(questions, [runId, ...from]);
      }
      if (opts.writes) {
        answered.set(runId, result);
        unfinished.get(mine)?.delete(hash);
      }
      // A second call answered from the first spends nothing. A child found ended in the store is
      // counted: its parent stopped before it saved the answer, so the spend is not counted yet.
      if (!earlier) ctx.spend?.(result.usage);
      if (result.status === "completed") {
        const answer = { runId, output: result.output };
        if (opts.writes) remember(mine, hash, { answer, callId: ctx.callId });
        return answer;
      }
      const reason =
        result.status === "failed"
          ? `${result.reason}: ${result.message}`
          : `rejected: ${(result as { output?: { reason?: string } }).output?.reason ?? result.status}`;
      const why = result.status === "failed" ? `failed, ${reason}` : `ended ${result.status}`;
      // A child that waits on setup (a sign-in, a key) is not tried again, and neither is this:
      // the run that started it all ends saying what to set up, once.
      if (result.status === "failed" && result.message.startsWith(NEEDS_SETUP)) {
        if (opts.writes) {
          failures.set(
            mine,
            Array.from({ length: MAX_WRITING_ATTEMPTS }, () => reason),
          );
        }
        throw new NeedsSetup(result.message.slice(NEEDS_SETUP.length).trim());
      }
      if (opts.writes) {
        // a try found ended in the store is already counted among the failures
        const counted = tries.some((t) => t.runId === runId && t.ended);
        if (!counted) failures.set(mine, [...failedTries(ctx.runId, key), reason]);
        const nth = failedTries(ctx.runId, key).length;
        const left = MAX_WRITING_ATTEMPTS - nth;
        throw new Error(
          `${child.spec.id}${key !== undefined ? ` for ${key}` : ""} (run ${runId}) ${why}. Try ${nth} of ${MAX_WRITING_ATTEMPTS}; ${
            left > 0
              ? "it may be called again, and a person approves that."
              : "it is not tried again: a person has to look."
          }`,
        );
      }
      throw new Error(`${child.spec.id} (run ${runId}) ${why}`);
    },
  };
}

/** A try that completed, and the parent's call that made it (none on older saves). */
interface Completed {
  answer: ChildAnswer;
  callId?: string;
}

/** One try of a writing child, as the run store has it. */
interface SavedTry {
  attempt: number;
  runId: string;
  /** What it was asked (`inputKey`); none on a try saved before inputs were kept. */
  hash?: string;
  /** The parent's call that started it; none on older saves. */
  callId?: string;
  ended?: NonNullable<RunCheckpoint["ended"]>;
}

const triedOut = (child: AnyAgent, n: number, key?: string) =>
  `${child.spec.id}${key !== undefined ? ` for ${key}` : ""} was tried ${n} times in this run (each a need of its own, or a try again after a failure) and is not tried again: a person has to look.`;

const needsAPerson = (child: AnyAgent, n: number, last: string | undefined, key?: string) =>
  `${child.spec.id}${key !== undefined ? ` for ${key}` : ""} failed ${n} time(s) in this run and is not tried again: a person has to look.${last ? ` The last failure: ${last}` : ""}`;

/** What the model reads when it asks a writing child the same thing again. */
const alreadyAnswered = (child: AnyAgent, output: unknown) =>
  `${child.spec.id} already answered for this same need in this run; it is not run again for the same need, so change the need to ask again. Its answer, which was built once and is not a new result: ${JSON.stringify(output)}`;

/** The input a tool that fronts children takes back out of its resolved form: the retry note is for the person. */
const withoutRetry = (given: unknown): unknown => {
  if (typeof given !== "object" || given === null) return given;
  const { retry: _retry, ...rest } = given as Record<string, unknown>;
  return rest;
};

/**
 * The tool that hands a part of the parent's work to `child`: its input is the child's input,
 * its answer the child's output. The child is a run of its own (own transcript, save points and
 * events) under the parent's tenant, with at most the budget the parent has left, and what it
 * spends counts against the parent.
 *
 * A child that writes makes this tool a write: the parent's call waits for a person's yes like
 * any write, and that yes covers the child's own writes. It builds one thing per input: once a try
 * has completed, a later call with the same input answers with what it built and builds nothing
 * new (refused before anyone is asked, after a restart too); a call with a different input is a
 * try of its own, approved like any. A try that failed can be made again, up to
 * MAX_WRITING_ATTEMPTS, each a new call a person approves and is shown the last failure for; and
 * no run makes more than MAX_WRITING_TRIES tries of one child, whatever became of them.
 */
export function agentTool(caller: ChildCaller): Tool {
  const { child, writes } = caller;
  return defineTool<unknown, unknown, unknown>({
    name: agentToolName(child.spec.id),
    description: [
      child.spec.description ??
        `Hand a part of the work to the ${child.spec.id} agent, and get its answer.`,
      ...(writes
        ? [
            `It builds one thing for each thing you ask: once it has completed, asking the same again answers with what it built and builds nothing new; ask something different (a changed input) and it runs again. If a try fails you may call it again with what the failure says to change: a person approves each try, and after ${MAX_WRITING_ATTEMPTS} failures, or ${MAX_WRITING_TRIES} tries of any kind in this run, it is not tried again.`,
          ]
        : []),
    ].join(" "),
    input: child.input,
    effect: writes ? "write" : "read",
    resumable: true,
    timeoutMs: CHILD_TIMEOUT_MS,
    // a repeat call is shown to the person with which try it is and what the last one failed on
    ...(writes
      ? {
          resolve(input: unknown, ctx: { runId: string }) {
            const failed = caller.failuresFor(ctx.runId);
            if (failed.length === 0 || caller.completedForInput(ctx.runId, input)) return input;
            const retry: Retry = {
              attempt: failed.length + 1,
              of: MAX_WRITING_ATTEMPTS,
              lastFailure: failed.at(-1) ?? "",
            };
            return { ...(input as object), retry };
          },
          block(input: unknown, ctx: { runId: string; callId?: string }) {
            return caller.refusal(ctx.runId, input, ctx.callId);
          },
        }
      : {}),
    // the retry note is for the person who approved the call, not for the child
    run: async (given, ctx) => {
      const answer = await caller.call(withoutRetry(given), ctx);
      return answer.again ? alreadyAnswered(child, answer.output) : answer;
    },
  }) as Tool;
}

/** How a pipeline calls one child. */
export interface PipelineCall {
  /**
   * Names the call among several to one writing child, so each is a child of its own: its own
   * run, its own answer once completed, its own tries (ADR 0025, amendment). Without one, the
   * child builds one thing per run.
   */
  key?: string;
}

/** What a pipeline's own pause brought back: a person's answers to the questions it asked. */
export interface PipelineContext {
  /**
   * The answers, when the pipeline itself stopped the run with questions (`AwaitingAnswers`) and
   * runs again now that they came. Answers to a child's questions go to that child, not here.
   */
  answered?: { by: string; answers: Answers };
  /** What the model passed the pipeline's tool, checked against `Pipeline.input`: its decisions, as ordinary input. */
  args?: unknown;
}

/**
 * A pipeline that reports what is open and stops short (tools report, the agent asks) returns only
 * `open` (and a `note`): it has not completed, so a later call runs it again.
 */
export function isOpenResult(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const o = output as { open?: unknown };
  return (
    Array.isArray(o.open) &&
    o.open.length > 0 &&
    Object.keys(output).every((k) => k === "open" || k === "note")
  );
}

/** A fixed sequence of the agents a parent may call, run by code. */
export interface Pipeline {
  /** The tool's name, e.g. `page.build`. */
  name: string;
  description: string;
  /**
   * What the model may pass the tool: the decisions the pipeline reported as open, as ordinary
   * input (the pipeline reads them from `own.args`). No arguments when left out.
   */
  input?: z.ZodObject;
  /** Start without a person approving the call; the children's writes still go through under it. */
  noApproval?: boolean;
  /** How many calls may run at once, where the pipeline starts several together. Default 2. */
  concurrency?: number;
  /**
   * Runs the agents. `call` runs one and answers with its output; it throws when that agent
   * failed. Calls with different keys may be started together (`Promise.all`); `concurrency` of
   * them run at a time. `input` is the run's own input. The pipeline may stop the run for a person
   * itself (throw `AwaitingAnswers`): it is run again with their answers in `own.answered`, and the
   * children that completed are not run again.
   */
  run(
    call: (child: AnyAgent, input: unknown, opts?: PipelineCall) => Promise<unknown>,
    input: unknown,
    own?: PipelineContext,
  ): Promise<unknown>;
}

/** Longer than one child's wait: a pipeline runs several. */
export const PIPELINE_TIMEOUT_MS = 45 * 60_000;

/** The most calls a pipeline runs at once unless it says otherwise. */
export const PIPELINE_CONCURRENCY = 2;

/** A call that was never started, because another stopped the run to ask a person. */
export class PausedForAnswers extends Error {
  constructor() {
    super("not started: another call stopped the run to ask a person");
  }
}

/** At most `limit` of the functions passed run at once; the rest wait their turn. */
function limiter(limit: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((go) => queue.push(go));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

/**
 * A tool that runs several agents in code: the steps are known, so the model does not decide
 * them (the spec's R5: prefer a program when the steps are known). It is one write a person
 * approves once; the children's writes go through under that yes. A stage that completed stays
 * done when the tool is called again after a later stage failed, and a stage that failed is tried
 * again, each call approved, up to MAX_WRITING_ATTEMPTS per stage and key.
 *
 * Calls with different keys to one child may run together. When one of them asks a person, the
 * others are let finish or ask first, so no child is left running while the run waits; the pause
 * carries the first one's questions, and the answers go to that child alone (`answered.from`
 * names it). The others that were waiting ask again, one pause each (ADR 0029's one pause at a time).
 */
export function pipelineTool(pipeline: Pipeline, callers: ChildCaller[]): Tool {
  const byId = new Map(callers.map((c) => [c.child.spec.id, c]));
  const writes = callers.some((c) => c.writes);
  const done = new Map<string, unknown>();
  /** Every (caller, key) that has state in this parent run; the unkeyed one first. */
  const calls = (runId: string) =>
    callers.flatMap((caller) =>
      [undefined, ...caller.keysFor(runId)].map((key) => ({ caller, key })),
    );
  const lastFailure = (runId: string): Retry | undefined => {
    for (const { caller, key } of calls(runId)) {
      const failed = caller.failuresFor(runId, key);
      if (failed.length > 0 && !caller.completedFor(runId, key)) {
        return {
          stage: caller.child.spec.id,
          ...(key !== undefined ? { key } : {}),
          attempt: failed.length + 1,
          of: MAX_WRITING_ATTEMPTS,
          lastFailure: failed.at(-1) ?? "",
        };
      }
    }
    return undefined;
  };
  return defineTool<unknown, unknown, unknown>({
    name: pipeline.name,
    description: pipeline.description,
    input: (pipeline.input ?? z.object({})).strict(),
    effect: writes ? "write" : "read",
    ...(pipeline.noApproval ? { noApproval: true } : {}),
    resumable: true,
    timeoutMs: PIPELINE_TIMEOUT_MS,
    resolve(input: unknown, ctx: { runId: string }) {
      const retry = lastFailure(ctx.runId);
      return retry && !done.has(ctx.runId) ? { ...(input as object), retry } : input;
    },
    block(_input: unknown, ctx: { runId: string }) {
      if (done.has(ctx.runId)) {
        return `${pipeline.name} already completed in this run, with this answer: ${JSON.stringify(done.get(ctx.runId))}`;
      }
      const spent = calls(ctx.runId).find(
        ({ caller, key }) => caller.failuresFor(ctx.runId, key).length >= MAX_WRITING_ATTEMPTS,
      );
      return spent
        ? needsAPerson(
            spent.caller.child,
            spent.caller.failuresFor(ctx.runId, spent.key).length,
            spent.caller.failuresFor(ctx.runId, spent.key).at(-1),
            spent.key,
          )
        : undefined;
    },
    async run(given, ctx) {
      const limit = limiter(Math.max(1, pipeline.concurrency ?? PIPELINE_CONCURRENCY));
      const inflight = new Set<Promise<unknown>>();
      // Once a call has stopped the run to ask a person, a call still waiting its turn is not
      // started: the question reaches the person now, not after the rest have run (ticket 11).
      let asking = false;
      const call = (child: AnyAgent, input: unknown, opts: PipelineCall = {}) => {
        const caller = byId.get(child.spec.id);
        if (!caller) {
          return Promise.reject(
            new Error(`${child.spec.id} is not an agent ${pipeline.name} may run`),
          );
        }
        const { key } = opts;
        const turn = limit(async () => {
          if (asking) throw new PausedForAnswers();
          try {
            return (
              await caller.call(input, ctx, {
                stage: child.spec.id,
                ...(key !== undefined ? { key } : {}),
              })
            ).output;
          } catch (err) {
            if (err instanceof AwaitingAnswers) asking = true;
            throw err;
          }
        });
        inflight.add(turn);
        turn.then(
          () => inflight.delete(turn),
          () => inflight.delete(turn),
        );
        return turn;
      };
      let output: unknown;
      try {
        // answers that came from no child are to the pipeline's own questions
        const answered = ctx.answered && !ctx.answered.from?.length ? ctx.answered : undefined;
        output = await pipeline.run(call, ctx.input, {
          ...(answered ? { answered } : {}),
          args: given,
        });
      } finally {
        // no child is left running when this call ends: a pause or a failure waits for the rest
        await Promise.allSettled([...inflight]);
      }
      // open items are not an answer: the model decides them and calls again
      if (!isOpenResult(output)) done.set(ctx.runId, output);
      return output;
    },
  }) as Tool;
}
