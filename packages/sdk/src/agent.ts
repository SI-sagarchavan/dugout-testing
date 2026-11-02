import { join } from "node:path";
import {
  type AgentDefinition,
  AgentSpec,
  type ApprovalRequest,
  type EventSink,
  type Message,
  type ModelClient,
  type RunContext,
  type RunHook,
  type RunStore,
  type Tool,
} from "@dugout/contracts";
import {
  type Approver,
  type CompletedRun,
  loadTenants,
  type ModelConfig,
  modelEntry,
  REPO_ROOT,
  type RunLocalOptions,
  runLocal,
  type Tenant,
} from "@dugout/core";
import {
  type LessonWriter,
  type MemoryStore,
  memoryGroups,
  memoryHooks,
  SKILL_TOOL,
} from "@dugout/memory";
import type { z } from "zod";

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
  /**
   * The shared memory scopes a run reads too (ADR 0014): what every tenant reads, and its sports.
   * Defaults to the tenant's sports in `config/tenants.json`, or the `sports` given when the run's
   * input names them.
   */
  memoryGroups?: (tenantId: string, sports?: string[]) => string[];
}

/** One run of an agent. */
export interface RunOptions<Input> {
  /** Must already be verified by the host, never taken from the model or the input. */
  tenantId: string;
  input: Input;
  approver: Approver;
  runId?: string;
  sinks?: EventSink[];
  /** Runs on this model, a name in the deps' `models`, instead of the one the agent was created with. */
  model?: string;
  /** Keeps the run's working memory, so it can wait for an approval or be resumed (ADR 0006). */
  store?: RunStore;
  resume?: RunLocalOptions["resume"];
}

export type AgentResult = Awaited<ReturnType<typeof runLocal>>;

/** How the terminal (`pnpm agent <id>`, apps/cli) shows this agent. All optional. */
export interface AgentCli {
  /** Other command-line names for input fields, e.g. `{ fixture: "fixtureId" }`. */
  flags?: Record<string, string>;
  /** The approval request as a reviewer reads it. Defaults to the tool name and its input as JSON. */
  present?: (req: Pick<ApprovalRequest, "tool" | "input">) => string;
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
  /** The sports a run is about, when its input says (ADR 0014); its shared memory narrows to them. */
  sportsOf?: (input: z.output<Input>) => string[] | undefined;
  /** Tool outputs longer than this are stored and replaced by a reference. */
  maxInlineChars?: number;
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
  create(deps: AgentDeps & Options): (opts: RunOptions<z.input<Input>>) => Promise<AgentResult>;
}

/**
 * Any agent, whatever its input and options: what a host serving several agents takes. Its run
 * function still checks the input against the agent's schema.
 */
export type AnyAgent = Omit<Agent, "create"> & {
  create(deps: AgentDeps): (opts: RunOptions<never>) => Promise<AgentResult>;
};

/**
 * An agent from its spec, input (and optional output) schema and tools. Memory (skills, house
 * facts, lessons, consolidation), the run log, approvals and saving the run come from the harness;
 * hosts pass the model, the memory store and the approver when they run it.
 */
export function defineAgent<Input extends z.ZodType, Options extends object = object>(
  config: AgentConfig<Input, Options>,
): Agent<Input, Options> {
  const spec = AgentSpec.parse(config.spec);
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
      const run: AgentDefinition = deps.model
        ? { ...definition, spec: { ...spec, model: deps.model } }
        : definition;
      const memory = memoryHooks({
        store: deps.store,
        spec,
        skillsDir,
        contextWindow: model.contextWindow,
        ...(deps.lessons ? { lessons: deps.lessons } : {}),
        ...(deps.consolidate === false ? { consolidate: false } : {}),
        groupsOf: (tenantId, input) =>
          (deps.memoryGroups ?? registryGroups)(
            tenantId,
            input === undefined ? undefined : config.sportsOf?.(input as z.output<Input>),
          ),
      });
      const tools = [...config.tools(deps), ...memory.tools];
      const missing = spec.tools.filter((name) => !tools.some((t) => t.name === name));
      if (missing.length) {
        throw new Error(`${spec.id}: spec.tools lists ${missing.join(", ")}, but no such tool`);
      }

      /** The definition a run uses: the agent's, or on the model the run names. */
      const definitionFor = (model?: string): AgentDefinition => {
        if (!model) return run;
        modelEntry(deps.models, model);
        return { ...run, spec: { ...run.spec, model } };
      };

      return (opts) =>
        runLocal({
          agent: definitionFor(opts.model),
          input: config.input.parse(opts.input),
          tenantId: opts.tenantId,
          tools,
          client: deps.client,
          models: deps.models,
          approver: opts.approver,
          context: memory.context,
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
