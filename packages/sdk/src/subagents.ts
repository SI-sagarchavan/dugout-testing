import { createHash } from "node:crypto";
import {
  type AgentSpec,
  AUTO_APPROVED,
  AwaitingAnswers,
  approve,
  type ChildRef,
  defineTool,
  type EventSink,
  NEEDS_SETUP,
  NeedsSetup,
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
  (parent: { runId: string; callId: string }): Responder =>
  async () =>
    approve(`the call that started this run (${parent.runId} ${parent.callId})${AUTO_APPROVED}`);

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

/** The run id of the n-th try of a writing child: the first keeps the id it always had. */
const attemptId = (parentRunId: string, agentId: string, attempt: number) =>
  childRunId(parentRunId, attempt === 1 ? `${ONCE}${agentId}` : `${ONCE}${agentId}:${attempt}`);

/** What a person is shown on a repeat call to a writing child: which try this is, and the last failure. */
interface Retry {
  /** The agent that failed, when a pipeline runs several. */
  stage?: string;
  attempt: number;
  of: number;
  lastFailure: string;
}

/** A child's answer: its run and what it output. */
export interface ChildAnswer {
  runId: string;
  output: unknown;
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
  /** One try. Throws when the child failed, or when it was tried `MAX_WRITING_ATTEMPTS` times. */
  call(input: unknown, ctx: ToolContext, stage?: string): Promise<ChildAnswer>;
  completedFor(parentRunId: string): ChildAnswer | undefined;
  failuresFor(parentRunId: string): string[];
}

/** A child run's sink: each of its events, written to the stream of the run that called it. */
function relayTo(
  relay: NonNullable<ToolContext["relay"]>,
  child: { runId: string; agentId: string; parentOf: { runId: string; callId: string } },
): EventSink {
  const ref: ChildRef = {
    runId: child.runId,
    agentId: child.agentId,
    parentRunId: child.parentOf.runId,
    callId: child.parentOf.callId,
  };
  return { write: (event) => relay({ ...event, child: event.child ?? ref }) };
}

export function childCaller(
  parent: AgentSpec,
  child: AnyAgent,
  runChild: RunChild,
  run: Pick<RunOptions<unknown>, "sinks" | "store" | "children" | "model">,
  opts: { writes: boolean },
): ChildCaller {
  // a writing child's completed answer, and how each failed try failed, by parent run: this
  // invocation's memory (the store, when there is one, is what a restarted worker goes by)
  const completed = new Map<string, ChildAnswer>();
  const failures = new Map<string, string[]>();
  const answered = new Map<string, AgentResult>();
  const failedTries = (parentRunId: string) => failures.get(parentRunId) ?? [];

  return {
    child,
    writes: opts.writes,
    completedFor: (parentRunId) => completed.get(parentRunId),
    failuresFor: failedTries,
    async call(input, ctx, stage) {
      const done = completed.get(ctx.runId);
      if (done) return done;
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
      // A child that writes builds one thing per parent run: its run id comes from the parent run,
      // its agent id and which try this is, not the call. A try that completed is answered again
      // without a new child; one that failed is skipped, and the next try is a child of its own.
      // A child that reads runs per call (and per stage, where one call runs several).
      let attempt = 1;
      let runId = childRunId(ctx.runId, stage ? `${ctx.callId}:${stage}` : ctx.callId);
      if (opts.writes) {
        attempt = failedTries(ctx.runId).length + 1;
        if (run.store) {
          // the store is what a restarted worker has: the tries that ended without completing
          attempt = 1;
          const ended: string[] = [];
          for (;;) {
            const saved = await run.store.load({
              runId: attemptId(ctx.runId, child.spec.id, attempt),
              tenantId: ctx.tenantId,
            });
            const over = saved?.checkpoint.ended;
            if (!over || over.status === "completed") break;
            ended.push(
              over.status === "failed"
                ? `${over.reason}: ${over.message}`
                : `rejected: ${over.output.reason}`,
            );
            attempt++;
          }
          if (ended.length > failedTries(ctx.runId).length) failures.set(ctx.runId, ended);
        }
        if (attempt > MAX_WRITING_ATTEMPTS) {
          throw new Error(needsAPerson(child, attempt - 1, failedTries(ctx.runId).at(-1)));
        }
        runId = attemptId(ctx.runId, child.spec.id, attempt);
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
      const answering = saved?.checkpoint.waiting?.questions && ctx.answered;
      const earlier = answered.get(runId);
      const result =
        earlier ??
        (await runChild({
          tenantId: ctx.tenantId,
          input: input as never,
          responder: askingAPerson(opts.writes ? approvedWithCall(parentOf) : refuseWrites),
          runId,
          depth,
          parent: parentOf,
          usdPerRun,
          // the child's questions are about what this run works on (ADR 0033)
          ...(ctx.situation ? { situation: ctx.situation } : {}),
          // a host that named the model for the run named it for the whole tree
          ...(run.model ? { model: run.model } : {}),
          // one stream per invocation: the child's events go to this run's stream, tagged as
          // the child's; a grandchild's come up through the child, keeping their own tag
          ...(ctx.relay
            ? { sinks: [relayTo(ctx.relay, { runId, agentId: child.spec.id, parentOf })] }
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
      if (opts.writes) answered.set(runId, result);
      // A second call answered from the first spends nothing. A child found ended in the store is
      // counted: its parent stopped before it saved the answer, so the spend is not counted yet.
      if (!earlier) ctx.spend?.(result.usage);
      if (result.status === "completed") {
        const answer = { runId, output: result.output };
        if (opts.writes) completed.set(ctx.runId, answer);
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
            ctx.runId,
            Array.from({ length: MAX_WRITING_ATTEMPTS }, () => reason),
          );
        }
        throw new NeedsSetup(result.message.slice(NEEDS_SETUP.length).trim());
      }
      if (opts.writes) {
        failures.set(ctx.runId, [...failedTries(ctx.runId).slice(0, attempt - 1), reason]);
        const left = MAX_WRITING_ATTEMPTS - attempt;
        throw new Error(
          `${child.spec.id} (run ${runId}) ${why}. Try ${attempt} of ${MAX_WRITING_ATTEMPTS}; ${
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

const needsAPerson = (child: AnyAgent, n: number, last: string | undefined) =>
  `${child.spec.id} failed ${n} time(s) in this run and is not tried again: a person has to look.${last ? ` The last failure: ${last}` : ""}`;

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
 * any write, and that yes covers the child's own writes. It builds one thing per parent run: once
 * a try has completed, later calls answer with what it built and build nothing new. A try that
 * failed can be made again, up to MAX_WRITING_ATTEMPTS, each a new call a person approves and is
 * shown the last failure for.
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
            `It builds one thing per run: once it has completed, calling it again answers with what it built and builds nothing new. If a try fails you may call it again with what the failure says to change: a person approves each try, and after ${MAX_WRITING_ATTEMPTS} failures it is not tried again.`,
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
            if (failed.length === 0 || caller.completedFor(ctx.runId)) return input;
            const retry: Retry = {
              attempt: failed.length + 1,
              of: MAX_WRITING_ATTEMPTS,
              lastFailure: failed.at(-1) ?? "",
            };
            return { ...(input as object), retry };
          },
          block(_input: unknown, ctx: { runId: string }) {
            const done = caller.completedFor(ctx.runId);
            if (done) {
              return `${child.spec.id} already completed in this run, with this answer, which is not built again: ${JSON.stringify(done.output)}`;
            }
            const failed = caller.failuresFor(ctx.runId);
            return failed.length >= MAX_WRITING_ATTEMPTS
              ? needsAPerson(child, failed.length, failed.at(-1))
              : undefined;
          },
        }
      : {}),
    // the retry note is for the person who approved the call, not for the child
    run: (given, ctx) => caller.call(withoutRetry(given), ctx),
  }) as Tool;
}

/** A fixed sequence of the agents a parent may call, run by code. */
export interface Pipeline {
  /** The tool's name, e.g. `page.build`. */
  name: string;
  description: string;
  /**
   * Runs the agents in order. `call` runs one and answers with its output; it throws when that
   * agent failed. `input` is the run's own input.
   */
  run(
    call: (child: AnyAgent, input: unknown) => Promise<unknown>,
    input: unknown,
  ): Promise<unknown>;
}

/** Longer than one child's wait: a pipeline runs several. */
export const PIPELINE_TIMEOUT_MS = 45 * 60_000;

/**
 * A tool that runs several agents in a fixed order, in code: the steps are known, so the model
 * does not decide them (the spec's R5: prefer a program when the steps are known). It is one
 * write a person approves once; the children's writes go through under that yes. A stage that
 * completed stays done when the tool is called again after a later stage failed, and a stage that
 * failed is tried again, each call approved, up to MAX_WRITING_ATTEMPTS per stage.
 */
export function pipelineTool(pipeline: Pipeline, callers: ChildCaller[]): Tool {
  const byId = new Map(callers.map((c) => [c.child.spec.id, c]));
  const writes = callers.some((c) => c.writes);
  const done = new Map<string, unknown>();
  const lastFailure = (runId: string): Retry | undefined => {
    for (const caller of callers) {
      const failed = caller.failuresFor(runId);
      if (failed.length > 0 && !caller.completedFor(runId)) {
        return {
          stage: caller.child.spec.id,
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
    input: z.object({}).strict(),
    effect: writes ? "write" : "read",
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
      const spent = callers.find((c) => c.failuresFor(ctx.runId).length >= MAX_WRITING_ATTEMPTS);
      return spent
        ? needsAPerson(
            spent.child,
            spent.failuresFor(ctx.runId).length,
            spent.failuresFor(ctx.runId).at(-1),
          )
        : undefined;
    },
    async run(_given, ctx) {
      const call = async (child: AnyAgent, input: unknown) => {
        const caller = byId.get(child.spec.id);
        if (!caller) throw new Error(`${child.spec.id} is not an agent ${pipeline.name} may run`);
        return (await caller.call(input, ctx, child.spec.id)).output;
      };
      const output = await pipeline.run(call, ctx.input);
      done.set(ctx.runId, output);
      return output;
    },
  }) as Tool;
}
