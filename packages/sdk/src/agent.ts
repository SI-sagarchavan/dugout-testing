import { join } from "node:path";
import {
  type AgentDefinition,
  AgentSpec,
  type ApprovalRequest,
  type EventSink,
  type ModelClient,
  type RunStore,
  type Tool,
} from "@dugout/contracts";
import {
  type Approver,
  type ModelConfig,
  REPO_ROOT,
  type RunLocalOptions,
  runLocal,
} from "@dugout/core";
import { type LessonWriter, type MemoryStore, memoryHooks, SKILL_TOOL } from "@dugout/memory";
import type { z } from "zod";

/** What the host (CLI, API, evals, tests) supplies: the model, memory, and where runs are written. */
export interface AgentDeps {
  store: MemoryStore;
  client: ModelClient;
  models: ModelConfig;
  /** Where run folders go. Defaults to `.runs` at the repo root. */
  runsDir?: string;
  /** False for eval and test runs that must not write memory. */
  consolidate?: boolean;
  /** Turns a rejection or change request into a lesson; without it the reviewer's words are kept. */
  lessons?: LessonWriter | undefined;
  /** Adds its sink to every run (Langfuse). */
  tracing?: { sink(): EventSink } | undefined;
}

/** One run of an agent. */
export interface RunOptions<Input> {
  /** Must already be verified by the host, never taken from the model or the input. */
  tenantId: string;
  input: Input;
  approver: Approver;
  runId?: string;
  sinks?: EventSink[];
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
  /** Instructions, tool allow-list, skills, model tier, memory scopes, budget, approvals. */
  spec: z.input<typeof AgentSpec>;
  input: Input;
  /** When set, the run ends through the `final` tool, its input checked against this schema. */
  output?: z.ZodType;
  /** The agent's folder: skills are read from `skills/`. Nothing in it is per tenant. */
  dir: string;
  /**
   * The agent's own tools. `options` are whatever the host passed to `create` besides the
   * standard deps (e.g. a folder for tests to write into). Memory tools are added.
   */
  tools: (options: Options) => Tool[];
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
  const definition: AgentDefinition = { spec, ...(config.output ? { output: config.output } : {}) };
  const skillsDir = join(config.dir, "skills");

  return {
    kind: "agent",
    spec,
    input: config.input,
    definition,
    skillsDir,
    cli: config.cli ?? {},

    create(deps) {
      const memory = memoryHooks({
        store: deps.store,
        spec,
        skillsDir,
        contextWindow: deps.models.tiers[spec.model.tier].contextWindow,
        ...(deps.lessons ? { lessons: deps.lessons } : {}),
        ...(deps.consolidate === false ? { consolidate: false } : {}),
      });
      const tools = [...config.tools(deps), ...memory.tools];
      const missing = spec.tools.filter((name) => !tools.some((t) => t.name === name));
      if (missing.length) {
        throw new Error(`${spec.id}: spec.tools lists ${missing.join(", ")}, but no such tool`);
      }

      return (opts) =>
        runLocal({
          agent: definition,
          input: config.input.parse(opts.input),
          tenantId: opts.tenantId,
          tools,
          client: deps.client,
          models: deps.models,
          approver: opts.approver,
          context: memory.context,
          afterRun: memory.afterRun,
          runsDir: deps.runsDir ?? join(REPO_ROOT, ".runs"),
          sinks: [...(opts.sinks ?? []), ...(deps.tracing ? [deps.tracing.sink()] : [])],
          ...(config.maxInlineChars ? { maxInlineChars: config.maxInlineChars } : {}),
          ...(opts.runId ? { runId: opts.runId } : {}),
          ...(opts.store ? { store: opts.store } : {}),
          ...(opts.resume ? { resume: opts.resume } : {}),
        });
    },
  };
}
