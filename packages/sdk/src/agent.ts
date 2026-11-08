import { join } from "node:path";
import {
  type AgentDefinition,
  AgentSpec,
  type EventSink,
  type InterruptRequest,
  type Message,
  type ModelClient,
  type RunContext,
  type RunHook,
  type RunStore,
  type Situation,
  type Tool,
} from "@dugout/contracts";
import {
  type CompletedRun,
  loadTenants,
  type ModelConfig,
  modelEntry,
  REPO_ROOT,
  type Responder,
  type RunLocalOptions,
  runLocal,
  type Tenant,
} from "@dugout/core";
import { defaultMcpHost, type McpHost } from "@dugout/mcp";
import {
  createDecisionMemory,
  type LessonWriter,
  type MemoryStore,
  memoryGroups,
  memoryHooks,
  SKILL_TOOL,
  type ThreadNotes,
} from "@dugout/memory";
import type { z } from "zod";
import {
  agentTool,
  agentToolName,
  type ChildRuns,
  childCaller,
  type Pipeline,
  pipelineTool,
} from "./subagents.ts";

/** What the host (CLI, API, evals, tests) supplies: the model, memory, and where runs are written. */
export interface AgentDeps {
  store: MemoryStore;
  client: ModelClient;
  models: ModelConfig;
  /** Runs on this model, a name in `models`, instead of the one the spec names (`--model`). */
  model?: string;
  /** Where run folders go. Defaults to `.runs` at the repo root. */
  runsDir?: string;
  /** Waits before each retry of a transient model error; tests pass a short one. */
  retryDelayMs?: (attempt: number) => number;
  /** False for eval and test runs that must not write memory. */
  consolidate?: boolean;
  /** Turns a rejection or change request into a lesson; without it the reviewer's words are kept. */
  lessons?: LessonWriter | undefined;
  /** Adds its sink to every run (Langfuse). */
  tracing?: { sink(): EventSink } | undefined;
  /** The MCP servers agents resolve their capabilities against; the process's own by default. */
  mcp?: McpHost;
  /**
   * The shared memory scopes a run reads too (ADR 0014): what every tenant reads, and its sports.
   * Defaults to the tenant's sports in `config/tenants.json`, or the `sports` given when the run's
   * input names them.
   */
  memoryGroups?: (tenantId: string, sports?: string[]) => string[];
  /**
   * The threads' notes (ADR 0031): a run a host started reads what earlier runs in its thread
   * did, and leaves a note when it ends. Left out (tests, evals), runs read and write none.
   */
  threads?: ThreadNotes;
}

/** One run of an agent. */
export interface RunOptions<Input> {
  /** Must already be verified by the host, never taken from the model or the input. */
  tenantId: string;
  input: Input;
  responder: Responder;
  runId?: string;
  sinks?: EventSink[];
  /** Runs on this model, a name in the deps' `models`, instead of the one the agent was created with. */
  model?: string;
  /** Keeps the run's working memory, so it can wait for an approval or be resumed (ADR 0006). */
  store?: RunStore;
  resume?: RunLocalOptions["resume"];
  /** Keeps the records of the child runs this run starts (ADR 0025); the worker passes one. */
  children?: ChildRuns;
  /** Set by the harness on a child run: how far down it is, and the run and call that started it. */
  depth?: number;
  parent?: { runId: string; callId: string };
  /** Set by the harness on a child run: what its parent works on at the call (ADR 0033). */
  situation?: Situation;
  /** Caps the spec's budget for this run: a child gets no more than its parent has left. */
  usdPerRun?: number;
}

export type AgentResult = Awaited<ReturnType<typeof runLocal>>;

/** What `create` returns: the function that runs the agent, and the tools a run of it has. */
export type AgentRun<Input> = ((opts: RunOptions<Input>) => Promise<AgentResult>) & {
  /** Its own and memory's, not the agent tools a run adds for the agents it may call. */
  readonly tools: readonly Tool[];
  /** The spec a run serves: its own tools plus the ones its capabilities resolved to (ADR 0026). */
  readonly spec: AgentSpec;
};

/** How the terminal (`pnpm agent <id>`, apps/cli) shows this agent. All optional. */
export interface AgentCli {
  /** Other command-line names for input fields, e.g. `{ fixture: "fixtureId" }`. */
  flags?: Record<string, string>;
  /** The approval request as a reviewer reads it. Defaults to the tool name and its input as JSON. */
  present?: (req: Pick<InterruptRequest, "tool" | "input">) => string;
  /** A closing line after the run, e.g. where the result was saved. */
  done?: (result: Pick<AgentResult, "status">, tenantId: string) => string | undefined;
}

export interface AgentConfig<Input extends z.ZodType, Options extends object> {
  /** Instructions, tool allow-list, skills, model name, memory scopes, budget, approvals. */
  spec: z.input<typeof AgentSpec>;
  input: Input;
  /** When set, the run ends through the `final` tool, its input checked against this schema. */
  output?: z.ZodType;
  /** Sync check on the `final` result, no I/O; a string refuses it and goes back to the model. */
  verifyFinal?: (
    output: unknown,
    run: { ctx: RunContext; messages: Message[] },
  ) => string | undefined;
  /** Sync, no I/O: fills `final` fields a tool already returned, before `verifyFinal` runs. */
  completeFinal?: (output: unknown, run: { ctx: RunContext; messages: Message[] }) => unknown;
  /** The result's shape when `completeFinal` changes it; see `AgentDefinition.result`. */
  result?: z.ZodType;
  /** Whether a run of this input is expected to write; see `AgentDefinition.writeExpected`. */
  writeExpected?: (input: unknown) => boolean;
  /** Per-turn rules of this agent, run after the harness's own; see `AgentDefinition.hooks`. */
  hooks?: RunHook[];
  /** The agent's folder: skills are read from `skills/`. Nothing in it is per tenant. */
  dir: string;
  /**
   * The agent's own tools. `options` are whatever the host passed to `create` besides the
   * standard deps (e.g. a folder for tests to write into). Memory tools are added.
   */
  tools: (options: Options) => Tool[];
  /**
   * Runs after the model has finished, in the same process, before memory consolidation.
   * A failure is recorded on the result and does not change the run status.
   */
  afterRun?: (run: CompletedRun, deps: AgentDeps & Options) => Promise<void>;
  /**
   * What a run did, in a sentence or two, for its thread's note (ADR 0031): the next run on the
   * same section starts from it. Left out, the note says what the output and events show.
   */
  threadNote?: (input: z.output<Input>, output: unknown) => string | undefined;
  /** The sports a run is about, when its input says (ADR 0014); its shared memory narrows to them. */
  sportsOf?: (input: z.output<Input>) => string[] | undefined;
  /** Tool outputs longer than this are stored and replaced by a reference. */
  maxInlineChars?: number;
  /**
   * Agents this one may hand a part of its work to (ADR 0025). Each becomes a tool,
   * `agent.<camelId>`; a call starts a child run. A call to an agent that writes is itself a
   * write: a person approves the call, and the child's writes go through under it.
   */
  agents?: AnyAgent[];
  /**
   * Runs the agents it may call in a fixed order, in code, as one tool (`pipeline.name`), instead
   * of leaving each to the model as `agent.<id>`: for when the steps are known. The tool is one
   * write a person approves once; the children's writes go through under that yes.
   */
  pipeline?: Pipeline;
  cli?: AgentCli;
}

export interface Agent<Input extends z.ZodType = z.ZodType, Options extends object = object> {
  readonly kind: "agent";
  readonly spec: AgentSpec;
  readonly input: Input;
  readonly definition: AgentDefinition;
  readonly skillsDir: string;
  readonly cli: AgentCli;
  /** Binds the host's deps and returns the function that runs the agent. */
  create(deps: AgentDeps & Options): AgentRun<z.input<Input>>;
}

/**
 * Any agent, whatever its input and options: what a host serving several agents takes. Its run
 * function still checks the input against the agent's schema.
 */
export type AnyAgent = Omit<Agent, "create"> & {
  create(deps: AgentDeps): AgentRun<never>;
};

/**
 * An agent from its spec, input (and optional output) schema and tools. Memory (skills, house
 * facts, lessons, consolidation), the run log, approvals and saving the run come from the harness;
 * hosts pass the model, the memory store and the responder when they run it.
 */
export function defineAgent<Input extends z.ZodType, Options extends object = object>(
  config: AgentConfig<Input, Options>,
): Agent<Input, Options> {
  const children = config.agents ?? [];
  const declared = AgentSpec.parse(config.spec);
  const childIds = children.map((child) => child.spec.id);
  if (declared.agents && declared.agents.join() !== childIds.join()) {
    throw new Error(
      `${declared.id}: spec.agents lists ${declared.agents.join(", ")}, but agents are ${childIds.join(", ") || "none"}`,
    );
  }
  if (children.length > 0 && declared.budget.maxDepth < 1) {
    throw new Error(`${declared.id}: calls agents, so budget.maxDepth must be 1 or more`);
  }
  if (config.pipeline && children.length === 0) {
    throw new Error(`${declared.id}: has a pipeline, so agents must list the agents it runs`);
  }
  // each agent it may call is a tool of its own, allowed like any other tool in the spec; a
  // pipeline is one tool for all of them
  const agentTools = config.pipeline ? [config.pipeline.name] : childIds.map(agentToolName);
  const spec: AgentSpec = children.length
    ? { ...declared, agents: childIds, tools: [...declared.tools, ...agentTools] }
    : declared;
  if (spec.onDemandSkills.length > 0 && !spec.tools.includes(SKILL_TOOL)) {
    throw new Error(`${spec.id}: onDemandSkills needs ${SKILL_TOOL} in spec.tools`);
  }
  const both = spec.skills.filter((name) => spec.onDemandSkills.includes(name));
  if (both.length > 0) {
    throw new Error(`${spec.id}: ${both.join(", ")} in both skills and onDemandSkills`);
  }
  const definition: AgentDefinition = {
    spec,
    ...(config.output ? { output: config.output } : {}),
    ...(config.verifyFinal ? { verifyFinal: config.verifyFinal } : {}),
    ...(config.completeFinal ? { completeFinal: config.completeFinal } : {}),
    ...(config.result ? { result: config.result } : {}),
    ...(config.writeExpected ? { writeExpected: config.writeExpected } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
  };
  const skillsDir = join(config.dir, "skills");

  return {
    kind: "agent",
    spec,
    input: config.input,
    definition,
    skillsDir,
    cli: config.cli ?? {},

    create(deps) {
      const model = modelEntry(deps.models, deps.model ?? spec.model);
      // The capabilities it needs from MCP servers, as the registry resolves them (ADR 0026): their
      // tools are its tools, the servers' guidance follows its own instructions.
      const mcp = deps.mcp ?? defaultMcpHost();
      const wanted = { requires: spec.requires ?? [], optional: spec.optional ?? [] };
      const resolved =
        wanted.requires.length + wanted.optional.length > 0 ? mcp.resolve(wanted) : undefined;
      const served: AgentSpec = resolved
        ? {
            ...spec,
            tools: [...spec.tools, ...resolved.tools.map((t) => t.name)],
            approvals: [...spec.approvals, ...resolved.approvals],
            ...(resolved.instructions
              ? { instructions: `${spec.instructions}\n\n${resolved.instructions}` }
              : {}),
          }
        : spec;
      const run: AgentDefinition = {
        ...definition,
        spec: deps.model ? { ...served, model: deps.model } : served,
      };
      const memory = memoryHooks({
        store: deps.store,
        spec,
        skillsDir,
        contextWindow: model.contextWindow,
        ...(deps.lessons ? { lessons: deps.lessons } : {}),
        ...(deps.consolidate === false ? { consolidate: false } : {}),
        ...(deps.threads ? { threads: deps.threads } : {}),
        ...(config.threadNote
          ? {
              threadNote: (input: unknown, output: unknown) =>
                config.threadNote?.(input as z.output<Input>, output),
            }
          : {}),
        groupsOf: (tenantId, input) =>
          (deps.memoryGroups ?? registryGroups)(
            tenantId,
            input === undefined ? undefined : config.sportsOf?.(input as z.output<Input>),
          ),
      });
      const tools = [
        ...config.tools({ ...deps, mcp }),
        ...memory.tools,
        ...(resolved?.tools ?? []),
      ];
      const missing = run.spec.tools.filter(
        (name) => !agentTools.includes(name) && !tools.some((t) => t.name === name),
      );
      if (missing.length) {
        throw new Error(`${spec.id}: spec.tools lists ${missing.join(", ")}, but no such tool`);
      }

      // A child runs on its own spec's model: the host's `--model` is for the run it started.
      const { model: _parentModel, ...childDeps } = deps;
      // A child that writes is called through a write: the call is what a person approves.
      const childRuns = children.map((child) => {
        const runChild = child.create(childDeps as AgentDeps);
        // by what the child serves, not what its spec lists: a capability's tools are its tools too
        const writes = runChild.tools.some(
          (t) => t.effect === "write" && runChild.spec.tools.includes(t.name),
        );
        return { child, runChild, writes };
      });

      /** The definition a run uses: the agent's, on the model the run names, within its budget. */
      const definitionFor = (model?: string, usdPerRun?: number): AgentDefinition => {
        if (model) modelEntry(deps.models, model);
        if (!model && usdPerRun === undefined) return run;
        return {
          ...run,
          spec: {
            ...run.spec,
            ...(model ? { model } : {}),
            ...(usdPerRun !== undefined
              ? {
                  budget: {
                    ...run.spec.budget,
                    usdPerRun: Math.min(usdPerRun, run.spec.budget.usdPerRun),
                  },
                }
              : {}),
          },
        };
      };

      /** The tools that run the agents it may call, with this run's own memory of how they went. */
      const childToolsFor = (opts: RunOptions<z.input<Input>>): Tool[] => {
        const callers = childRuns.map(({ child, runChild, writes }) =>
          childCaller(spec, child, runChild, opts, { writes }),
        );
        return config.pipeline
          ? [pipelineTool(config.pipeline, callers)]
          : callers.map((caller) => agentTool(caller));
      };

      const runAgent = (opts: RunOptions<z.input<Input>>) =>
        runLocal({
          agent: definitionFor(opts.model, opts.usdPerRun),
          input: config.input.parse(opts.input),
          tenantId: opts.tenantId,
          ...(opts.depth ? { depth: opts.depth } : {}),
          ...(opts.parent ? { parent: opts.parent } : {}),
          ...(opts.situation ? { situation: opts.situation } : {}),
          tools: [...tools, ...childToolsFor(opts)],
          client: deps.client,
          models: deps.models,
          responder: opts.responder,
          context: memory.context,
          // what people decided before, and the house facts, go into the questions this run asks (ADR 0033)
          learned: createDecisionMemory(deps.store, opts.tenantId),
          afterRun: async (run) => {
            // The agent's hook can fail (a disk, a missing checkout) and the run's lessons, examples
            // and record must still be written; its failure is reported after, not instead.
            let hookError: unknown;
            try {
              await config.afterRun?.(run, deps);
            } catch (err) {
              hookError = err;
            }
            await memory.afterRun(run);
            if (hookError !== undefined) throw hookError;
          },
          runsDir: deps.runsDir ?? join(REPO_ROOT, ".runs"),
          sinks: [...(opts.sinks ?? []), ...(deps.tracing ? [deps.tracing.sink()] : [])],
          ...(config.maxInlineChars ? { maxInlineChars: config.maxInlineChars } : {}),
          ...(opts.runId ? { runId: opts.runId } : {}),
          ...(opts.store ? { store: opts.store } : {}),
          ...(deps.retryDelayMs ? { retryDelayMs: deps.retryDelayMs } : {}),
          ...(opts.resume ? { resume: opts.resume } : {}),
        });
      return Object.assign(runAgent, { tools: tools as readonly Tool[], spec: run.spec });
    },
  };
}

let registry: Map<string, Tenant> | undefined;

/** A run's shared memory scopes from the tenant registry; what every tenant reads for one it lacks. */
function registryGroups(tenantId: string, sports?: string[]): string[] {
  registry ??= new Map(
    loadTenants()
      .list()
      .map((t) => [t.id, t]),
  );
  return memoryGroups(registry.get(tenantId), sports);
}
