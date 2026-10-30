import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentDefinition,
  ApprovalDecision,
  ApprovalPending,
  ApprovalRequest,
  EventSink,
  ModelClient,
  ModelTurn,
  RunContext,
  RunEvent,
  RunEventInput,
  RunMemoryContext,
  RunStore,
  Steps,
  Tool,
  ToolInputDelta,
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

/**
 * Decides an approval request. An approver that can't decide now (a worker waiting for a person)
 * answers `{ pending: true }`: the run saves its state and ends, and the decision resumes it.
 */
export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision | ApprovalPending>;

export interface LocalStepsOptions {
  ctx: RunContext;
  client: ModelClient;
  models: ModelConfig;
  executor: ToolExecutor;
  approver: Approver;
  log: RunLog;
  /** Keeps the run's working memory; without it the run cannot outlive this invocation. */
  store?: RunStore;
  now?: () => Date;
  /** How often streamed fragments are sent; defaults to `FRAGMENT_MS`. */
  fragmentMs?: number;
}

/**
 * Streamed text and tool arguments go out as one event per this many milliseconds, not one per
 * provider chunk (a few characters each): smooth enough to watch, with a fraction of the events.
 */
export const FRAGMENT_MS = 50;

/** Collects a model call's streamed fragments and emits them in batches: text, then each call. */
function batchFragments(log: RunLog, step: number, everyMs: number) {
  let text = "";
  const inputs = new Map<number, ToolInputDelta>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent: Promise<unknown> = Promise.resolve();
  const send = () => {
    clearTimeout(timer);
    timer = undefined;
    const batch: RunEventInput[] = [];
    if (text) batch.push({ type: "token", data: { step, text } });
    for (const delta of inputs.values())
      batch.push({ type: "tool.input.delta", data: { step, ...delta } });
    text = "";
    inputs.clear();
    sent = Promise.all([sent, ...batch.map((e) => log.emit(e))]);
  };
  const later = () => {
    timer ??= setTimeout(send, everyMs);
  };
  return {
    token(fragment: string) {
      text += fragment;
      later();
    },
    toolInput(delta: ToolInputDelta) {
      const pending = inputs.get(delta.index);
      if (pending) pending.text += delta.text;
      else inputs.set(delta.index, { ...delta });
      later();
    },
    flush() {
      send();
      return sent;
    },
  };
}

/** `Steps` that call the model, tools and approver directly in this process. */
export function createLocalSteps(opts: LocalStepsOptions): Steps {
  const now = opts.now ?? (() => new Date());
  return {
    async model({ step, tier, messages, tools }) {
      const config = opts.models.tiers[tier];
      const fragments = batchFragments(opts.log, step, opts.fragmentMs ?? FRAGMENT_MS);
      let turn: ModelTurn;
      try {
        turn = await opts.client.complete(
          { model: config.model, messages, tools },
          fragments.token,
          fragments.toolInput,
        );
      } finally {
        // every fragment is out before the step completes, or the call fails
        await fragments.flush();
      }
      const usage = {
        ...turn.tokens,
        ...priceTokens(opts.models.pricing, config.model, turn.tokens, now()),
      };
      return { ...turn, usage };
    },
    tool: (req) => opts.executor.execute(req, opts.ctx),
    async approval(req) {
      const answer = await opts.approver(req);
      if ("pending" in answer && !opts.store) {
        throw new Error(
          "an approver can only answer later when the run has a store to resume from",
        );
      }
      return answer;
    },
    ...(opts.store
      ? {
          checkpoint: (checkpoint, appended) =>
            (opts.store as RunStore).save(opts.ctx, checkpoint, appended),
        }
      : {}),
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
  /** Keeps the run's working memory; needed to wait for an approval or to resume. */
  store?: RunStore;
  /**
   * Carry on from the state `store` holds for `runId`. `decision` answers the approval the run
   * waits for. `startSeq` is the last `seq` the event log already has (defaults to the one saved
   * with the state), and `events` are the run's earlier events, for `afterRun`.
   */
  resume?: {
    reason: "approval" | "recovery";
    decision?: ApprovalDecision;
    startSeq?: number;
    events?: RunEvent[];
  };
}

export interface CompletedRun {
  ctx: RunContext;
  result: Exclude<RunResult, { status: "waiting" }>;
  /** Every event of the run, earlier invocations included when the host passed them. */
  events: RunEvent[];
}

/** Wires a whole in-process run: registry, executor, event log and steps. */
export async function runLocal(opts: RunLocalOptions) {
  const runId = opts.runId ?? randomUUID();
  const runsDir = opts.runsDir ?? ".runs";
  const ctx: RunContext = { runId, tenantId: opts.tenantId };
  const outputs = opts.outputs ?? createFileOutputStore(runsDir);
  const registry = createToolRegistry([...opts.tools, createReadOutputTool(outputs)]);
  const saved = opts.resume ? await opts.store?.load(ctx) : undefined;
  if (opts.resume && !saved) throw new Error(`no saved state for run ${runId}`);
  const recorded = createMemorySink();
  recorded.events.push(...(opts.resume?.events ?? []));
  const log = createRunLog(
    runId,
    [createJsonlSink(join(runsDir, runId, "events.jsonl")), recorded, ...(opts.sinks ?? [])],
    { startSeq: opts.resume?.startSeq ?? saved?.checkpoint.lastSeq ?? 0 },
  );
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
    ...(opts.store ? { store: opts.store } : {}),
  });
  // a resumed run keeps the instructions and memory it started with
  const context = saved ? undefined : await opts.context?.(ctx, opts.input);
  const result = await runAgent({
    agent: opts.agent,
    input: opts.input,
    ctx,
    registry,
    steps,
    log,
    ...(context ? { context } : {}),
    ...(saved && opts.resume
      ? {
          resume: {
            saved,
            reason: opts.resume.reason,
            ...(opts.resume.decision ? { decision: opts.resume.decision } : {}),
          },
        }
      : {}),
  });
  let afterRunError: string | undefined;
  if (result.status !== "waiting") {
    try {
      await opts.afterRun?.({ ctx, result, events: recorded.events });
    } catch (err) {
      afterRunError = err instanceof Error ? err.message : String(err);
    }
  }
  return { runId, ...result, ...(afterRunError ? { afterRunError } : {}) };
}
