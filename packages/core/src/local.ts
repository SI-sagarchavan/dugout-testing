import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentDefinition,
  ApprovalDecision,
  ApprovalRequest,
  EventSink,
  ModelClient,
  RunContext,
  RunEvent,
  RunMemoryContext,
  Steps,
  Tool,
} from "@dugout/contracts";
import { createJsonlSink, createMemorySink, createRunLog, type RunLog } from "./events.ts";
import { type RunResult, runAgent } from "./loop.ts";
import type { ModelConfig } from "./model/config.ts";
import { priceTokens } from "./model/pricing.ts";
import { createFileOutputStore, type OutputStore } from "./output-store.ts";
import {
  createReadOutputTool,
  createToolExecutor,
  createToolRegistry,
  type ToolExecutor,
} from "./tools.ts";

export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export interface LocalStepsOptions {
  ctx: RunContext;
  client: ModelClient;
  models: ModelConfig;
  executor: ToolExecutor;
  approver: Approver;
  log: RunLog;
  now?: () => Date;
}

/** `Steps` that call the model, tools and approver directly in this process. */
export function createLocalSteps(opts: LocalStepsOptions): Steps {
  const now = opts.now ?? (() => new Date());
  return {
    async model({ step, tier, messages, tools }) {
      const config = opts.models.tiers[tier];
      const tokens: Promise<void>[] = [];
      const turn = await opts.client.complete(
        {
          model: config.model,
          messages,
          tools,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          ...(config.extraBody ? { extraBody: config.extraBody } : {}),
        },
        (text) => void tokens.push(opts.log.emit({ type: "token", data: { step, text } })),
      );
      await Promise.all(tokens);
      const usage = {
        ...turn.tokens,
        ...priceTokens(opts.models.pricing, config.model, turn.tokens, now()),
      };
      return { ...turn, usage };
    },
    tool: (req) => opts.executor.execute(req, opts.ctx),
    approval: (req) => opts.approver(req),
  };
}

export interface RunLocalOptions {
  agent: AgentDefinition;
  input: unknown;
  /** Must already be verified by the caller (the CLI checks it against the tenant registry). */
  tenantId: string;
  tools: Tool[];
  client: ModelClient;
  models: ModelConfig;
  approver: Approver;
  runId?: string;
  /** Where run folders go; defaults to `.runs` in the working directory. */
  runsDir?: string;
  /** Extra sinks; the run's `events.jsonl` is always written. */
  sinks?: EventSink[];
  outputs?: OutputStore;
  /** Tool outputs longer than this are stored and replaced by a reference. */
  maxInlineChars?: number;
  /** Builds the run's skills and memory context before the loop starts. */
  context?: (ctx: RunContext, input: unknown) => Promise<RunMemoryContext>;
  /** Runs after the loop ends, e.g. memory consolidation. Its error is reported, not thrown. */
  afterRun?: (run: CompletedRun) => Promise<void>;
}

export interface CompletedRun {
  ctx: RunContext;
  result: RunResult;
  events: RunEvent[];
}

/** Wires a whole in-process run: registry, executor, event log and steps. */
export async function runLocal(opts: RunLocalOptions) {
  const runId = opts.runId ?? randomUUID();
  const runsDir = opts.runsDir ?? ".runs";
  const ctx: RunContext = { runId, tenantId: opts.tenantId };
  const outputs = opts.outputs ?? createFileOutputStore(runsDir);
  const registry = createToolRegistry([...opts.tools, createReadOutputTool(outputs)]);
  const recorded = createMemorySink();
  const log = createRunLog(runId, [
    createJsonlSink(join(runsDir, runId, "events.jsonl")),
    recorded,
    ...(opts.sinks ?? []),
  ]);
  const steps = createLocalSteps({
    ctx,
    client: opts.client,
    models: opts.models,
    executor: createToolExecutor({
      registry,
      outputs,
      ...(opts.maxInlineChars ? { maxInlineChars: opts.maxInlineChars } : {}),
    }),
    approver: opts.approver,
    log,
  });
  const context = await opts.context?.(ctx, opts.input);
  const result = await runAgent({
    agent: opts.agent,
    input: opts.input,
    ctx,
    registry,
    steps,
    log,
    ...(context ? { context } : {}),
  });
  let afterRunError: string | undefined;
  try {
    await opts.afterRun?.({ ctx, result, events: recorded.events });
  } catch (err) {
    afterRunError = err instanceof Error ? err.message : String(err);
  }
  return { runId, ...result, ...(afterRunError ? { afterRunError } : {}) };
}
