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
 * Builds one trace per run from its events: a root span for the run, a generation span per model
 * step, and a span per tool call and approval wait. It reads only the (already redacted) event
 * stream, so tracing never sees anything the event log doesn't.
 */
export function createTracingSink(tracer: Tracer, onRunEnd?: () => Promise<void>): EventSink {
  const runs = new Map<string, { root: Span; lastAt: Date; open: Map<string, Span> }>();

  return {
    async write(event: RunEvent) {
      if (event.type === "token" || event.type === "tool.input.delta") return;
      const at = new Date(event.at);
      if (event.type === "run.started") {
        const root = tracer.startSpan(`run ${event.data.agentId}`, {
          startTime: at,
          attributes: {
            "langfuse.trace.name": event.data.agentId,
            "langfuse.user.id": event.data.tenantId,
            "langfuse.session.id": event.runId,
            "langfuse.trace.input": JSON.stringify(event.data.input),
            "dugout.run_id": event.runId,
            "dugout.tenant_id": event.data.tenantId,
            "dugout.agent_version": event.data.agentVersion,
          },
        });
        runs.set(event.runId, { root, lastAt: at, open: new Map() });
        return;
      }
      // A run resumed in another process (after an approval or a crash) gets a trace of its own
      // there, in the same Langfuse session as the rest of the run.
      if (event.type === "run.resumed" && !runs.has(event.runId)) {
        const root = tracer.startSpan(`run ${event.data.agentId} (resumed)`, {
          startTime: at,
          attributes: {
            "langfuse.trace.name": event.data.agentId,
            "langfuse.user.id": event.data.tenantId,
            "langfuse.session.id": event.runId,
            "dugout.run_id": event.runId,
            "dugout.tenant_id": event.data.tenantId,
            "dugout.agent_version": event.data.agentVersion,
            "dugout.resumed_reason": event.data.reason,
            "dugout.resumed_at_step": event.data.step,
          },
        });
        runs.set(event.runId, { root, lastAt: at, open: new Map() });
        return;
      }
      const run = runs.get(event.runId);
      if (!run) return;
      const parent = trace.setSpan(ROOT_CONTEXT, run.root);
      const child = (
        name: string,
        start: Date,
        attributes: Record<string, string | number | boolean>,
      ) => tracer.startSpan(name, { startTime: start, attributes }, parent);

      switch (event.type) {
        case "context.built":
          run.root.setAttribute("dugout.memory_tokens", event.data.tokens);
          run.root.setAttribute("dugout.memory_sources", event.data.sources.length);
          break;
        case "step.completed": {
          // the model call ran from the previous event to this one
          const { usage, message } = event.data;
          child(`model step ${event.data.step}`, run.lastAt, {
            "langfuse.observation.type": "generation",
            "gen_ai.response.model": event.data.servedModel,
            "gen_ai.usage.input_tokens": usage.inputTokens,
            "gen_ai.usage.output_tokens": usage.outputTokens,
            "gen_ai.usage.cached_input_tokens": usage.cachedInputTokens,
            "gen_ai.usage.reasoning_tokens": usage.reasoningTokens,
            "gen_ai.usage.cost": usage.costUsd,
            "gen_ai.response.finish_reasons": event.data.finishReason,
            "langfuse.observation.output": JSON.stringify({
              content: message.content,
              toolCalls: message.toolCalls ?? [],
            }),
          }).end(at);
          break;
        }
        case "tool.started":
          run.open.set(
            `tool:${event.data.callId}`,
            child(`tool ${event.data.tool}`, at, {
              "langfuse.observation.type": "tool",
              "langfuse.observation.input": JSON.stringify(event.data.input),
            }),
          );
          break;
        case "tool.completed": {
          const span = run.open.get(`tool:${event.data.callId}`);
          span?.setAttribute("langfuse.observation.output", event.data.content);
          if (!event.data.ok)
            span?.setStatus({ code: SpanStatusCode.ERROR, message: event.data.content });
          span?.end(at);
          run.open.delete(`tool:${event.data.callId}`);
          break;
        }
        case "final.refused":
          run.root.addEvent("final.refused", { reason: event.data.reason }, at);
          break;
        case "tool.denied":
          run.root.addEvent(
            "tool.denied",
            { tool: event.data.tool, stage: event.data.stage, reason: event.data.reason },
            at,
          );
          break;
        case "question.asked":
          // a write waiting for a yes is a review of its call; the rest are the agent's questions
          run.open.set(
            `pause:${event.data.callId}`,
            child(`${event.data.subject ? "review" : "ask"} ${event.data.tool}`, at, {}),
          );
          break;
        case "question.answered": {
          const span = run.open.get(`pause:${event.data.callId}`);
          const review = event.data.answers.review;
          const verdict = typeof review === "object" && !Array.isArray(review) ? review : undefined;
          if (verdict) span?.setAttribute("dugout.approved", verdict.decision === "approve");
          if (verdict?.decision === "change")
            span?.setAttribute("dugout.changes", verdict.comment ?? "");
          span?.setAttribute("dugout.responder", event.data.by);
          span?.setAttribute("dugout.answer_source", event.data.source);
          span?.end(at);
          run.open.delete(`pause:${event.data.callId}`);
          break;
        }
        case "run.completed":
        case "run.failed":
        case "run.cancelled": {
          for (const span of run.open.values()) span.end(at);
          run.root.setAttribute("dugout.cost_usd", event.data.usage.costUsd);
          if (event.type === "run.completed") {
            run.root.setAttribute("dugout.status", event.data.status);
            run.root.setAttribute("langfuse.trace.output", JSON.stringify(event.data.output));
          } else if (event.type === "run.cancelled") {
            run.root.setAttribute("dugout.status", "cancelled");
            run.root.setAttribute("dugout.cancelled_by", event.data.by);
          } else {
            run.root.setAttribute("dugout.status", "failed");
            run.root.setStatus({
              code: SpanStatusCode.ERROR,
              message: `${event.data.reason}: ${event.data.message}`,
            });
          }
          run.root.end(at);
          runs.delete(event.runId);
          await onRunEnd?.();
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

/** Tracing to Langfuse, or undefined when it isn't configured. Flushes after each run. */
export function loadTracing(env: Record<string, string | undefined> = process.env) {
  const exporter = langfuseExporter(env);
  if (!exporter) return undefined;
  const provider = createTracerProvider(new BatchSpanProcessor({ exporter }));
  const tracer = provider.getTracer("dugout");
  return {
    sink: () => createTracingSink(tracer, () => provider.forceFlush()),
    shutdown: () => provider.shutdown(),
  };
}
