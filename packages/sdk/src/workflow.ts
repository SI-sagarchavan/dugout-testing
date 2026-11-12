import {
  AwaitingAnswers,
  answeredCalls,
  defineState,
  defineTool,
  type FinalRun,
  type GateContext,
  isNeedsSetup,
  type Tool,
} from "@dugout/contracts";
import { CORRECTED_INPUT } from "@dugout/core";
import { z } from "zod";
import {
  type Agent,
  type AgentCli,
  type AgentConfig,
  type AnyAgent,
  agentWith,
  defineAgent,
} from "./agent.ts";
import type { Driver } from "./driver.ts";
import { type ChildCaller, isTriesSpent } from "./subagents.ts";

/**
 * A workflow (ADR 0037): the steps are known, so code decides what runs next, and a model is
 * called inside a step, where there is something to judge. An agent is the other shape: its model
 * decides what to do next. The patterns are code: one step after another with a check between
 * them, several at once (`Promise.all`), a step that picks the branch, a step that plans the work
 * and one run for each part, and a loop that ends when a step that grades says so.
 */

/** The tool a workflow's code runs under, unless it names its own. Its one call is the whole workflow. */
export const WORKFLOW_TOOL = "workflow.run";

/** The model a workflow names for its own turns, which code takes: it is never called. */
const UNUSED_MODEL = "haiku";

/** A step of a workflow: one model call with a typed answer. It is the smallest agent. */
export type Step<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> = Agent<
  Input,
  object
> & { readonly answer: Output };

export interface StepConfig<Input extends z.ZodType, Output extends z.ZodType> {
  /** Lower case with hyphens, its own among the workflow's steps: `squad-need`. */
  id: string;
  /** A name in `config/models.json`. */
  model: string;
  instructions: string;
  input: Input;
  /** The answer's shape: the model gives it through `final`, and it is checked. */
  output: Output;
  description?: string;
  /** Skills in full in its instructions, read from `dir/skills`. */
  skills?: string[];
  dir?: string;
  /**
   * Refuses an answer that parses and is still wrong (a name that is not one it was given); the
   * reason goes back to the model.
   */
  verify?: (output: z.output<Output>, input: z.output<Input>) => string | undefined;
  /** What one call may spend. Defaults to $0.25. */
  usdPerRun?: number;
}

/**
 * One model call with a typed answer, for a workflow to run: no tools of its own, so the model
 * reads its instructions and input and answers. It may still `ask` a person what only they can
 * settle. A step that needs tools is an agent: write it with `defineAgent`.
 */
export function defineStep<Input extends z.ZodType, Output extends z.ZodType>(
  config: StepConfig<Input, Output>,
): Step<Input, Output> {
  const { verify } = config;
  const agent = defineAgent<Input>({
    spec: {
      id: config.id,
      ...(config.description ? { description: config.description } : {}),
      instructions: config.instructions,
      model: config.model,
      skills: config.skills ?? [],
      // a question to a person, the answer, a try again when it was refused, and the last
      // turn, which must answer
      budget: { usdPerRun: config.usdPerRun ?? 0.25, maxSteps: 4, maxDepth: 0 },
      approvals: [],
    },
    input: config.input,
    output: config.output,
    ...(config.dir ? { dir: config.dir } : {}),
    ...(verify
      ? {
          verifyFinal: (output, run) =>
            verify(output as z.output<Output>, run.ctx.input as z.output<Input>),
        }
      : {}),
  });
  return Object.assign(agent, { answer: config.output });
}

export interface RunStepOptions {
  /**
   * Names this call among several to the same step or agent: a loop's pass, one item of a list.
   * It is what a resumed workflow finds the call's result by, so it is the same each time.
   */
  key?: string;
  /**
   * How many times to try it before its failure is the call's: 1 unless said. A step that writes
   * is tried three times at most in a run, whatever this says.
   */
  tries?: number;
}

/** What a workflow's code runs its steps with. */
export interface WorkflowContext {
  /** Runs a step and answers with its typed output. Throws when it failed. */
  run<Input extends z.ZodType, Output extends z.ZodType>(
    step: Step<Input, Output>,
    input: z.input<Input>,
    opts?: RunStepOptions,
  ): Promise<z.output<Output>>;
  /** Runs an agent, as a child run, and answers with its output. Throws when it failed. */
  run(agent: AnyAgent, input: unknown, opts?: RunStepOptions): Promise<unknown>;
}

export interface WorkflowConfig<Input extends z.ZodType, Output extends z.ZodType> {
  id: string;
  /** What it does, in a line: what a person approving it reads, and a parent that may call it. */
  description: string;
  input: Input;
  output: Output;
  /** Every step and agent the workflow may run. */
  steps: AnyAgent[];
  /**
   * The workflow: ordinary code. After a pause or a crash it is run again from the top, and each
   * step that completed answers at once with what it answered before, so write it so the same
   * input makes the same calls with the same keys.
   */
  run(ctx: WorkflowContext, input: z.output<Input>): Promise<z.input<Output>>;
  /** How many steps may run at once, where several are started together. Default 2. */
  concurrency?: number;
  /**
   * `once` (the default): when a step writes, a person approves the workflow before it starts,
   * and that yes covers its steps' writes. `none`: it starts without asking.
   */
  approval?: "once" | "none";
  /** What the whole workflow may spend. Defaults to $3. */
  usdPerRun?: number;
  /** The name of the tool its code runs under, as events and hosts show it. `workflow.run` unless said. */
  tool?: string;
  /** As an agent's (`AgentConfig.threadNote`): a sentence, or what it did, made and left open. */
  threadNote?: AgentConfig<Input, object>["threadNote"];
  cli?: AgentCli;
}

const Done = z.object({});

/**
 * What a workflow answered with when it completed, kept in the run's state (ADR 0035): the run's
 * result is read from it. `runId` is the run it completed in: a fork carries its parent's state,
 * and runs the workflow again.
 */
export const WORKFLOW_RESULT = defineState<{ output: unknown; runId: string }>("workflow.result");

/** Longer than one step's wait: a workflow runs several. */
export const WORKFLOW_TIMEOUT_MS = 45 * 60_000;

/** The most steps a workflow runs at once unless it says otherwise. */
export const WORKFLOW_CONCURRENCY = 2;

/** A step that was never started, because another stopped the run to ask a person. */
class PausedForAnswers extends Error {
  constructor() {
    super("not started: another step stopped the run to ask a person");
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
 * The tool a workflow's code runs under. One call is the whole workflow; a call a crash or a pause
 * cut short is run again from the top, and each step that completed answers from its own save.
 *
 * Steps with different keys may be started together. When one asks a person, the others are let
 * finish or ask first, so no step is left running while the run waits; the pause carries the
 * first one's questions, and the answers go to that step alone. The others that were waiting ask
 * again, one pause each (ADR 0029's one pause at a time).
 */
function workflowTool<Input extends z.ZodType, Output extends z.ZodType>(
  config: WorkflowConfig<Input, Output>,
  name: string,
  callers: ChildCaller[],
): Tool {
  const byId = new Map(callers.map((c) => [c.child.spec.id, c]));
  // a workflow with a step that writes is a write: its yes covers its steps' writes
  const writes = callers.some((c) => c.writes);
  const completedIn = (ctx: GateContext) => {
    const done = ctx.state.get(WORKFLOW_RESULT);
    return done?.runId === ctx.runId ? done : undefined;
  };
  return defineTool<unknown, unknown, unknown>({
    name,
    description: config.description,
    input: z.object({}).strict(),
    effect: writes ? "write" : "read",
    ...(config.approval === "none" ? { noApproval: true } : {}),
    resumable: true,
    timeoutMs: WORKFLOW_TIMEOUT_MS,
    block(_input: unknown, ctx: GateContext) {
      const done = completedIn(ctx);
      return done
        ? `${name} already completed in this run, with this answer: ${JSON.stringify(done.output)}`
        : undefined;
    },
    async run(_given, ctx) {
      const limit = limiter(Math.max(1, config.concurrency ?? WORKFLOW_CONCURRENCY));
      const inflight = new Set<Promise<unknown>>();
      // Once a step has stopped the run to ask a person, one still waiting its turn is not
      // started: the question reaches the person now, not after the rest have run.
      let asking = false;
      // a pause for a person, or a setup, is the run's: code that catches a step's failure to go
      // another way does not get to swallow it
      let stop: unknown;
      const made = new Set<string>();

      const once = (step: AnyAgent, input: unknown, key: string | undefined, attempt: number) => {
        const caller = byId.get(step.spec.id);
        if (!caller) {
          return Promise.reject(new Error(`${step.spec.id} is not a step ${config.id} lists`));
        }
        // a step that writes counts its own tries; one that only reads is a run for each call
        // and key, so a later try is a run of its own
        const runKey = !caller.writes && attempt > 1 ? `${key ?? ""}~${attempt}` : key;
        const turn = limit(async () => {
          if (asking) throw new PausedForAnswers();
          try {
            const answer = await caller.call(input, ctx, {
              stage: step.spec.id,
              ...(runKey !== undefined ? { key: runKey } : {}),
            });
            return answer.output;
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

      const context: WorkflowContext = {
        async run(step: AnyAgent, input: unknown, opts: RunStepOptions = {}) {
          const called = `${step.spec.id}${opts.key === undefined ? "" : `@${opts.key}`}`;
          if (made.has(called)) {
            throw new Error(
              `${config.id} runs ${step.spec.id} twice${opts.key === undefined ? "" : ` with the key ${opts.key}`}: give each call its own key (a loop's pass, an item's id), so a resumed run finds each one's result`,
            );
          }
          made.add(called);
          const tries = Math.max(1, opts.tries ?? 1);
          for (let attempt = 1; ; attempt++) {
            try {
              return await once(step, input, opts.key, attempt);
            } catch (err) {
              if (
                err instanceof AwaitingAnswers ||
                err instanceof PausedForAnswers ||
                isNeedsSetup(err)
              ) {
                stop ??= err;
                throw err;
              }
              // a step that writes says when it has no tries left in this run
              if (attempt >= tries || isTriesSpent(err)) throw err;
            }
          }
        },
      };

      let output: unknown;
      try {
        output = await config.run(context, config.input.parse(ctx.input) as z.output<Input>);
      } finally {
        // no step is left running when this call ends: a pause or a failure waits for the rest
        await Promise.allSettled([...inflight]);
      }
      if (stop) throw stop;
      // checked here, so a workflow that returns the wrong shape fails where it did
      const result = config.output.parse(output);
      // kept in the run's state (ADR 0035): the run's result is read from there, and a run
      // resumed in another process still knows the workflow completed
      ctx.state.set(WORKFLOW_RESULT, { output: result ?? null, runId: ctx.runId });
      return result;
    },
  }) as Tool;
}

/**
 * The workflow's own turns, taken by code: start the workflow, then hand over its result. After
 * a corrected input (a fork, a follow-up) it starts again. Its steps are fixed, so when the tool
 * fails nothing here can try another way: the run ends with what was said.
 */
export function workflowDriver(id: string, description: string, tool: string): Driver {
  return (req) => {
    const corrected = req.messages.findLastIndex(
      (m) => m.role === "user" && m.content.startsWith(CORRECTED_INPUT),
    );
    const mine = answeredCalls(req.messages, tool)
      .filter((c) => c.at > corrected)
      .at(-1);
    if (!mine) {
      // a workflow that writes says why, for the person who approves it
      const asks = req.tools.find((t) => t.name === tool)?.parameters as
        | { required?: string[] }
        | undefined;
      return [
        {
          name: tool,
          ...(asks?.required?.includes("reason") ? { arguments: { reason: description } } : {}),
        },
      ];
    }
    if (mine.isError) throw new Error(mine.content.replace(/^Error: /, ""));
    if (mine.content.startsWith("Not run:")) {
      throw new Error(`${id} was sent back for a change, and a workflow's steps are fixed`);
    }
    const refused = answeredCalls(req.messages, "final").find((c) => c.at > mine.at && c.isError);
    if (refused) throw new Error(refused.content);
    return [{ name: "final" }];
  };
}

/**
 * A workflow as a run: its code runs under one tool, each step a child run with its own
 * transcript, save points and events, in this run's stream and against this run's budget. So it
 * pauses for a person, resumes and is followed like any run. Its own turns (start the code, hand
 * over the result) are taken by code, not a model.
 */
export function defineWorkflow<Input extends z.ZodType, Output extends z.ZodType>(
  config: WorkflowConfig<Input, Output>,
): Agent<Input, object> {
  if (config.steps.length === 0) throw new Error(`${config.id}: a workflow runs at least one step`);
  const tool = config.tool ?? WORKFLOW_TOOL;
  const built = (run: Pick<FinalRun, "state" | "ctx">) => {
    const kept = run.state.get(WORKFLOW_RESULT);
    // a fork's own result, not the one its parent left in the state it carries
    const parsed =
      kept && kept.runId === run.ctx.runId ? config.output.safeParse(kept.output) : undefined;
    return parsed?.success ? parsed.data : undefined;
  };

  return agentWith<Input>(
    {
      spec: {
        id: config.id,
        description: config.description,
        instructions: `A workflow: code runs its steps in a fixed order. ${config.description}`,
        model: UNUSED_MODEL,
        memory: { read: [], write: [] },
        budget: {
          usdPerRun: config.usdPerRun ?? 3,
          // start the code and hand over the result, and again for each corrected input
          maxSteps: 12,
          // a step may be an agent that runs agents of its own
          maxDepth: 1 + Math.max(...config.steps.map((s) => s.spec.budget.maxDepth)),
        },
        approvals: [],
      },
      input: config.input,
      output: Done,
      result: config.output,
      completeFinal: (_output, run) => built(run),
      verifyFinal: (_output, run) =>
        built(run) === undefined ? `${config.id} has not completed in this run.` : undefined,
      ...(config.threadNote ? { threadNote: config.threadNote } : {}),
      ...(config.cli ? { cli: config.cli } : {}),
      agents: config.steps,
    },
    {
      runs: { name: tool, tool: (callers) => workflowTool(config, tool, callers) },
      driver: workflowDriver(config.id, config.description, tool),
    },
  );
}
