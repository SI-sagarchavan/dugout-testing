import type { EventSink, RunEvent } from "@dugout/contracts";
import { ROOT_CONTEXT, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

/**
 * Langfuse traces from a run's events, shaped as Langfuse's best practices ask
 * (https://langfuse.com/docs/observability/best-practices):
 *
 * - one trace per run, its root an `agent` observation named for the agent, with the run's input
 *   and output; the runs of a thread (a Handoff and every later run on its section) share a
 *   session, so the session view replays them in order;
 * - a `generation` per model call (`call-model`), with the model, exclusive token buckets, cost,
 *   what the model newly saw since its last call (the tool results and answers) as input, and its
 *   answer as an assistant message with `tool_calls`, so Langfuse renders the calls as cards;
 * - a `tool` per tool call, a sibling of the generation that asked for it;
 * - a child agent (`agent.dataBind`) as an `agent` observation in its parent's trace, its own
 *   generations and tools under it, when both runs are in this process;
 * - a person's approval or answer as an observation with the questions and the answers, and a
 *   refused final, a denied call or a compaction as a WARNING/DEFAULT `event`.
 *
 * Names are stable (no step numbers or ids in them); run-specific values are metadata under
 * `langfuse.*.metadata.*`, so they are filterable. It reads only the already-redacted event stream:
 * tracing never sees anything the event log does not.
 */
export interface TracingOptions {
  /** Flushes the exporter when a run ends, so a short-lived process does not lose its spans. */
  onRunEnd?: () => Promise<void>;
  /** The open spans of tool calls, by `runId/callId`: how a child's sink finds its parent's call. */
  calls?: Map<string, Span>;
  /** The session a run's trace belongs to: its thread. Without one, the run is its own session. */
  sessionOf?: (tenantId: string, runId: string) => Promise<string | undefined>;
  /** `production`, `staging`, `development`: keeps test traces out of production views. */
  environment?: string;
}

interface Message {
  role: "user" | "tool" | "system";
  content: string;
  tool_call_id?: string;
}

interface RunTrace {
  root: Span;
  /** The parent's call span stands in as this child's root: ended by the parent, not here. */
  borrowed: boolean;
  lastAt: Date;
  open: Map<string, Span>;
  /** What the model has been given since its last call: the input of its next generation. */
  pending: Message[];
}

/** A value as the JSON string an attribute holds; a string stays as it is. */
const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** Metadata attributes Langfuse maps to the top-level, filterable `metadata` object. */
function metadata(
  scope: "trace" | "observation",
  values: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[`langfuse.${scope}.metadata.${key}`] = String(value);
  }
  return out;
}

export function createTracingSink(tracer: Tracer, options: TracingOptions = {}): EventSink {
  const runs = new Map<string, RunTrace>();
  const calls = options.calls ?? new Map<string, Span>();
  const environment = options.environment ?? "development";

  /** The attributes every trace root carries: who, which agent, which session. */
  const traceAttributes = async (
    runId: string,
    data: { agentId: string; tenantId: string; agentVersion: number },
  ) => {
    const session =
      (await options.sessionOf?.(data.tenantId, runId).catch(() => undefined)) ?? runId;
    return {
      "langfuse.trace.name": data.agentId,
      "langfuse.user.id": data.tenantId,
      "langfuse.session.id": session,
      "langfuse.trace.tags": [`agent:${data.agentId}`, `tenant:${data.tenantId}`],
      "langfuse.environment": environment,
      "langfuse.version": String(data.agentVersion),
      ...metadata("trace", { run_id: runId, tenant_id: data.tenantId, thread_id: session }),
    };
  };

  return {
    async write(event: RunEvent) {
      if (event.type === "token" || event.type === "tool.input.delta") return;
      // a child's events relayed into its parent's stream: the child's own sink traces them
      if ((event as { child?: unknown }).child) return;
      const at = new Date(event.at);

      if (event.type === "run.started") {
        const { parent } = event.data;
        const call = parent ? calls.get(`${parent.runId}/${parent.callId}`) : undefined;
        const observation = {
          "langfuse.environment": environment,
          "langfuse.observation.type": "agent",
          "langfuse.observation.input": json(event.data.input),
          ...metadata("observation", {
            run_id: event.runId,
            agent_version: event.data.agentVersion,
            ...(parent ? { parent_run_id: parent.runId } : {}),
          }),
        };
        if (call) {
          // a child agent: its parent's call becomes the agent observation it runs under
          call.updateName(event.data.agentId);
          call.setAttributes(observation);
          runs.set(event.runId, {
            root: call,
            borrowed: true,
            lastAt: at,
            open: new Map(),
            pending: [{ role: "user", content: json(event.data.input) }],
          });
          return;
        }
        const root = tracer.startSpan(event.data.agentId, {
          startTime: at,
          attributes: {
            ...(await traceAttributes(event.runId, event.data)),
            ...observation,
            // legacy trace-level evaluators still read the trace's input
            "langfuse.trace.input": json(event.data.input),
          },
        });
        runs.set(event.runId, {
          root,
          borrowed: false,
          lastAt: at,
          open: new Map(),
          pending: [{ role: "user", content: json(event.data.input) }],
        });
        return;
      }

      // A run resumed in another process (after an approval or a crash) gets a trace of its own
      // there, in the same session as the rest of the run.
      if (event.type === "run.resumed" && !runs.has(event.runId)) {
        const root = tracer.startSpan(event.data.agentId, {
          startTime: at,
          attributes: {
            ...(await traceAttributes(event.runId, event.data)),
            "langfuse.observation.type": "agent",
            ...metadata("observation", {
              run_id: event.runId,
              resumed_reason: event.data.reason,
              resumed_at_step: event.data.step,
            }),
          },
        });
        runs.set(event.runId, { root, borrowed: false, lastAt: at, open: new Map(), pending: [] });
        return;
      }

      const run = runs.get(event.runId);
      if (!run) return;
      const parent = trace.setSpan(ROOT_CONTEXT, run.root);
      // environment is per observation in Langfuse: each one carries it, not only the root
      const child = (name: string, start: Date, attributes: Record<string, unknown>) =>
        tracer.startSpan(
          name,
          {
            startTime: start,
            attributes: { "langfuse.environment": environment, ...attributes } as Record<
              string,
              string
            >,
          },
          parent,
        );
      /** A point in the run worth seeing in the tree: a refusal, a denial, a compaction. */
      const point = (name: string, level: "DEFAULT" | "WARNING", input: unknown) =>
        child(name, at, {
          "langfuse.observation.type": "event",
          "langfuse.observation.level": level,
          "langfuse.observation.input": json(input),
        }).end(at);

      switch (event.type) {
        case "context.built":
          run.root.setAttributes(
            metadata("observation", {
              memory_tokens: event.data.tokens,
              memory_sources: event.data.sources.length,
            }),
          );
          break;
        case "context.compacted":
          point("compact-context", "DEFAULT", event.data);
          break;
        case "step.completed": {
          // the model call ran from the previous event to this one
          const { usage, message } = event.data;
          const cacheRead = usage.cachedInputTokens;
          const cacheWrite = usage.cacheWriteInputTokens;
          const reasoning = (message.reasoningBlocks ?? [])
            .map((b) => ("text" in b ? b.text : ""))
            .filter(Boolean)
            .join("\n");
          child("call-model", run.lastAt, {
            "langfuse.observation.type": "generation",
            "langfuse.observation.model.name": event.data.servedModel,
            "gen_ai.response.model": event.data.servedModel,
            // every token in exactly one bucket: input here excludes what the cache read or wrote
            "langfuse.observation.usage_details": json({
              input: Math.max(0, usage.inputTokens - cacheRead - cacheWrite),
              ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
              ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
              output: Math.max(0, usage.outputTokens - usage.reasoningTokens),
              ...(usage.reasoningTokens ? { output_reasoning_tokens: usage.reasoningTokens } : {}),
            }),
            "langfuse.observation.cost_details": json({ total: usage.costUsd }),
            "langfuse.observation.input": json(run.pending),
            "langfuse.observation.output": json({
              role: "assistant",
              content: message.content,
              ...(message.toolCalls?.length
                ? {
                    tool_calls: message.toolCalls.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  }
                : {}),
              ...(reasoning ? { reasoning } : {}),
            }),
            ...metadata("observation", {
              step: event.data.step,
              finish_reason: event.data.finishReason,
            }),
          }).end(at);
          run.pending = [];
          break;
        }
        case "tool.started": {
          const span = child(event.data.tool, at, {
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json(event.data.input),
            ...metadata("observation", { call_id: event.data.callId, step: event.data.step }),
          });
          run.open.set(`tool:${event.data.callId}`, span);
          calls.set(`${event.runId}/${event.data.callId}`, span);
          break;
        }
        case "tool.completed": {
          const span = run.open.get(`tool:${event.data.callId}`);
          span?.setAttribute("langfuse.observation.output", event.data.content);
          if (!event.data.ok)
            span?.setStatus({ code: SpanStatusCode.ERROR, message: event.data.content });
          span?.end(at);
          run.open.delete(`tool:${event.data.callId}`);
          calls.delete(`${event.runId}/${event.data.callId}`);
          run.pending.push({
            role: "tool",
            tool_call_id: event.data.callId,
            content: event.data.content,
          });
          break;
        }
        case "final.refused":
          point("refuse-final", "WARNING", { reason: event.data.reason });
          run.pending.push({ role: "user", content: `final refused: ${event.data.reason}` });
          break;
        case "tool.denied":
          point("deny-tool", "WARNING", {
            tool: event.data.tool,
            stage: event.data.stage,
            reason: event.data.reason,
          });
          break;
        case "question.asked": {
          // a write waiting for a yes is a review of its call; the rest are the agent's questions
          const review = !!event.data.subject;
          run.open.set(
            `pause:${event.data.callId}`,
            child(review ? "await-approval" : "ask-person", at, {
              "langfuse.observation.type": review ? "guardrail" : "span",
              "langfuse.observation.input": json(
                event.data.questions.map((q) => ({
                  id: q.id,
                  question: q.question,
                  why: q.why,
                  options: q.options.map((o) => o.value),
                  proposed: q.proposed,
                })),
              ),
              ...metadata("observation", { tool: event.data.tool, call_id: event.data.callId }),
            }),
          );
          break;
        }
        case "question.answered": {
          const span = run.open.get(`pause:${event.data.callId}`);
          span?.setAttributes({
            "langfuse.observation.output": json(event.data.answers),
            ...metadata("observation", { by: event.data.by, answer_source: event.data.source }),
          });
          span?.end(at);
          run.open.delete(`pause:${event.data.callId}`);
          if (event.data.answers.review === undefined) {
            run.pending.push({ role: "user", content: json(event.data.answers) });
          }
          break;
        }
        case "run.completed":
        case "run.failed":
        case "run.cancelled": {
          for (const span of run.open.values()) span.end(at);
          const status =
            event.type === "run.completed"
              ? event.data.status
              : event.type === "run.cancelled"
                ? "cancelled"
                : "failed";
          run.root.setAttributes(
            metadata("observation", {
              status,
              cost_usd: event.data.usage.costUsd,
              ...(event.type === "run.cancelled" ? { cancelled_by: event.data.by } : {}),
            }),
          );
          if (event.type === "run.completed") {
            run.root.setAttribute("langfuse.observation.output", json(event.data.output));
            if (!run.borrowed)
              run.root.setAttribute("langfuse.trace.output", json(event.data.output));
          } else if (event.type === "run.failed") {
            run.root.setStatus({
              code: SpanStatusCode.ERROR,
              message: `${event.data.reason}: ${event.data.message}`,
            });
          }
          // a child's root is its parent's call, which the parent's tool.completed ends
          if (!run.borrowed) run.root.end(at);
          runs.delete(event.runId);
          await options.onRunEnd?.();
          return;
        }
      }
      run.lastAt = at;
    },
  };
}

export function createTracerProvider(processor: SpanProcessor) {
  return new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "dugout" }),
    spanProcessors: [processor],
  });
}

/** Langfuse's OTLP endpoint, when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set. */
export function langfuseExporter(
  env: Record<string, string | undefined> = process.env,
): SpanExporter | undefined {
  const { LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk } = env;
  if (!pk || !sk) return undefined;
  const base = (env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/$/, "");
  return new OTLPTraceExporter({
    url: `${base}/api/public/otel/v1/traces`,
    headers: { Authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}` },
  });
}

/**
 * Tracing to Langfuse, or undefined when it isn't configured. Flushes after each run. Every sink it
 * makes shares one map of open tool calls, so a child run in this process nests in its parent's
 * trace. `sessionOf` names a run's session (its thread); `LANGFUSE_TRACING_ENVIRONMENT` its
 * environment (`development` unless set).
 */
export function loadTracing(
  env: Record<string, string | undefined> = process.env,
  extra: Pick<TracingOptions, "sessionOf"> = {},
) {
  const exporter = langfuseExporter(env);
  if (!exporter) return undefined;
  const provider = createTracerProvider(new BatchSpanProcessor({ exporter }));
  const tracer = provider.getTracer("dugout");
  const calls = new Map<string, Span>();
  const environment = env.LANGFUSE_TRACING_ENVIRONMENT || "development";
  return {
    sink: () =>
      createTracingSink(tracer, {
        onRunEnd: () => provider.forceFlush(),
        calls,
        environment,
        ...extra,
      }),
    shutdown: () => provider.shutdown(),
  };
}
