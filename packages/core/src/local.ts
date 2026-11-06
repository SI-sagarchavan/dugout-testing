import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentDefinition,
  Decision,
  EventSink,
  InterruptPending,
  InterruptRequest,
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
import { type AnswerMemory, type RunResult, runAgent } from "./loop.ts";
import { type ModelConfig, modelEntry } from "./model/config.ts";
import { TransientModelError } from "./model/errors.ts";
import { priceTokens } from "./model/pricing.ts";
import { createFileOutputStore, type OutputStore } from "./output-store.ts";
import {
  createReadOutputTool,
  createToolExecutor,
  createToolRegistry,
  type ToolExecutor,
} from "./tools.ts";

/**
 * Answers a pause for a person: questions, or a write waiting for a yes. A responder that can't decide now (a worker waiting for a person)
 * answers `{ pending: true }`: the run saves its state and ends, and the decision resumes it.
 */
export type Responder = (req: InterruptRequest) => Promise<Decision | InterruptPending>;

export interface LocalStepsOptions {
  ctx: RunContext;
  client: ModelClient;
  models: ModelConfig;
  executor: ToolExecutor;
  responder: Responder;
  log: RunLog;
  /** Keeps the run's working memory; without it the run cannot outlive this invocation. */
  store?: RunStore;
  /** How often streamed fragments are sent; defaults to `FRAGMENT_MS`. */
  fragmentMs?: number;
  /** Milliseconds to wait before retry `attempt` (1, 2, 3) of a transient model error; defaults to `retryDelay`. */
  retryDelayMs?: (attempt: number) => number;
}

/** A transient model error is tried again this many times before it goes to the caller. */
export const MODEL_RETRIES = 3;

/** 1s, 2s, 4s, each ±25% so runs that were throttled together don't come back together. */
export function retryDelay(attempt: number): number {
  return 1_000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `Steps` that call the model, tools and responder directly in this process. */
export function createLocalSteps(opts: LocalStepsOptions): Steps {
  return {
    async model({ step, model, messages, tools, toolChoice }) {
      const { price, forcedTools } = modelEntry(opts.models, model);
      const delay = opts.retryDelayMs ?? retryDelay;
      for (let attempt = 0; ; attempt++) {
        // new fragments per attempt: a failed call's half-sent batch is not carried over
        const fragments = batchFragments(opts.log, step, opts.fragmentMs ?? FRAGMENT_MS);
        let turn: ModelTurn;
        try {
          turn = await opts.client.complete(
            // the run goes on for more turns, so its prompt goes in the cache
            {
              model,
              messages,
              tools,
              cache: true,
              ...(toolChoice && forcedTools ? { toolChoice } : {}),
            },
            fragments.token,
            fragments.toolInput,
          );
        } catch (err) {
          // a retry may repeat `token` events the log already has; that is acceptable
          if (err instanceof TransientModelError && attempt < MODEL_RETRIES) {
            await sleep(delay(attempt + 1));
            continue;
          }
          throw err;
        } finally {
          // every fragment is out before the step completes, or the call fails
          await fragments.flush();
        }
        const usage = {
          ...turn.tokens,
          ...priceTokens(price, turn.tokens),
        };
        return { ...turn, usage };
      }
    },
    tool: (req) => opts.executor.execute(req, opts.ctx),
    async interrupt(req) {
      const answer = await opts.responder(req);
      if ("pending" in answer && !opts.store) {
        throw new Error(
          "a responder can only answer later when the run has a store to resume from",
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
  /** A child run's place: how far below the host's run, and the run and call that started it. */
  depth?: number;
  parent?: { runId: string; callId: string };
  tools: Tool[];
  client: ModelClient;
  models: ModelConfig;
  responder: Responder;
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
  /** What earlier answers tell the run about the questions it asks (ADR 0029). */
  learned?: AnswerMemory;
  /** Runs after the loop ends, e.g. memory consolidation. Its error is reported, not thrown. */
  afterRun?: (run: CompletedRun) => Promise<void>;
  /** Keeps the run's working memory; needed to wait for a person or to resume. */
  store?: RunStore;
  /** Waits before each retry of a transient model error; tests pass a short one. */
  retryDelayMs?: (attempt: number) => number;
  /**
   * Carry on from the state `store` holds for `runId`. `decision` answers the questions the run
   * waits for. `startSeq` is the last `seq` the event log already has (defaults to the one saved
   * with the state), and `events` are the run's earlier events, for `afterRun`.
   */
  resume?: {
    reason: "answered" | "recovery";
    decision?: Decision;
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
  const ctx: RunContext = {
    runId,
    tenantId: opts.tenantId,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.depth ? { depth: opts.depth } : {}),
    ...(opts.parent ? { parent: opts.parent } : {}),
  };
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
    responder: opts.responder,
    log,
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.retryDelayMs ? { retryDelayMs: opts.retryDelayMs } : {}),
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
    ...(opts.learned ? { learned: opts.learned } : {}),
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
  // a run resumed after it ended only answered with its ending: its afterRun has run already
  if (result.status !== "waiting" && !saved?.checkpoint.ended) {
    try {
      await opts.afterRun?.({ ctx, result, events: recorded.events });
    } catch (err) {
      afterRunError = err instanceof Error ? err.message : String(err);
    }
  }
  return { runId, ...result, ...(afterRunError ? { afterRunError } : {}) };
}
