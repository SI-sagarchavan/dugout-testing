import { readFile } from "node:fs/promises";
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
import { type LessonWriter, type MemoryStore, memoryHooks } from "@dugout/memory";
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

/** How the terminal runner (`pnpm agent <id>`) shows this agent. All optional. */
export interface AgentCli {
  /** Other command-line names for input fields, e.g. `{ fixture: "fixtureId" }`. */
  flags?: Record<string, string>;
  /** The approval request as a reviewer reads it. Defaults to the tool name and its input as JSON. */
  present?: (req: ApprovalRequest) => string;
  /** A closing line after the run, e.g. where the result was saved. */
  done?: (result: AgentResult, tenantId: string) => string | undefined;
}

export interface AgentConfig<Input extends z.ZodType, Options extends object> {
  /** Instructions, tool allow-list, skills, model tier, memory scopes, budget, approvals. */
  spec: z.input<typeof AgentSpec>;
  input: Input;
  /** When set, the run ends through the `final` tool, its input checked against this schema. */
  output?: z.ZodType;
  /** The agent's folder: skills are read from `skills/`, house facts from `data/<tenant>/style.json`. */
  dir: string;
  /**
   * The agent's own tools. `options` are whatever the host passed to `create` besides the
   * standard deps (e.g. a folder for tests to write into). Memory tools are added.
   */
  tools: (options: Options) => Tool[];
  /** Tool outputs longer than this are stored and replaced by a reference. */
  maxInlineChars?: number;
  /**
   * Whether hosts stream its responses by default (the API's `stream` flag decides per request).
   * Defaults to true for agents that answer in text, false for agents with an `output` schema,
   * whose callers usually want the checked result in one piece.
   */
  stream?: boolean;
  cli?: AgentCli;
}

export interface Agent<Input extends z.ZodType = z.ZodType, Options extends object = object> {
  readonly kind: "agent";
  readonly spec: AgentSpec;
  readonly input: Input;
  readonly definition: AgentDefinition;
  readonly skillsDir: string;
  readonly dataDir: string;
  /** Whether hosts stream its responses by default. */
  readonly stream: boolean;
  readonly cli: AgentCli;
  /** Binds the host's deps and returns the function that runs the agent. */
  create(deps: AgentDeps & Options): (opts: RunOptions<z.input<Input>>) => Promise<AgentResult>;
  /** Makes each tenant's house facts the agent's active semantic memory. Re-running changes nothing. */
  seed(store: MemoryStore, tenantIds: string[]): Promise<Record<string, number>>;
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
  const definition: AgentDefinition = { spec, ...(config.output ? { output: config.output } : {}) };
  const skillsDir = join(config.dir, "skills");
  const dataDir = join(config.dir, "data");

  return {
    kind: "agent",
    spec,
    input: config.input,
    definition,
    skillsDir,
    dataDir,
    stream: config.stream ?? !config.output,
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

    async seed(store, tenantIds) {
      const changes: Record<string, number> = {};
      for (const tenantId of tenantIds) {
        const facts = await houseFacts(dataDir, tenantId);
        if (!facts) continue;
        const active = new Map((await store.activeFacts(tenantId, spec.id)).map((f) => [f.key, f]));
        changes[tenantId] = 0;
        for (const fact of facts) {
          if (active.get(fact.key)?.content === fact.content) continue;
          const proposal = await store.proposeFact({
            tenantId,
            agentId: spec.id,
            ...fact,
            confidence: 1,
            sourceRunId: null,
          });
          await store.activateFact(tenantId, proposal.id, "seed");
          changes[tenantId]++;
        }
      }
      return changes;
    },
  };
}

/** A tenant's `style.json` facts, or undefined when the agent has none for that tenant. */
async function houseFacts(dataDir: string, tenantId: string) {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, tenantId, "style.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return (JSON.parse(raw) as { facts: Array<{ key: string; content: string }> }).facts;
}
