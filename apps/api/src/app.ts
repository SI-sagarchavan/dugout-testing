import type { RunEvent } from "@dugout/contracts";
import { createRedactor, type TenantRegistry } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import { type Identity, verifyToken } from "./auth.ts";
import { readStoredEvents, type ValkeyEventLog } from "./event-log.ts";
import { type InvocationEnd, RunError, type RunManager } from "./runs.ts";

/** Keeps CloudFront and the ALB from closing quiet streams in production. */
export const HEARTBEAT_MS = 15_000;
/** How long a request that doesn't stream waits for its run before answering 202 with the run id. */
export const MAX_WAIT_MS = 120_000;

export interface AppDeps {
  pool: Pool;
  runs: RunManager;
  events: ValkeyEventLog;
  tenants: TenantRegistry;
  secret: string;
  heartbeatMs?: number;
  maxWaitMs?: number;
}

/**
 * How a request that starts or resumes a run is answered (the same choice OpenAI's `stream` and
 * `background` give). Without either, the agent's default applies.
 * - `stream: true`: this invocation's events as SSE in the response, ending when the run ends or
 *   waits for an approval.
 * - `stream: false`: the result as JSON once the run ends or waits for an approval.
 * - `background: true`: the run id at once; follow `GET /runs/:id/stream` or poll `GET /runs/:id`.
 */
const ResponseMode = z
  .object({ stream: z.boolean().optional(), background: z.boolean().optional() })
  .refine((m) => !(m.stream && m.background));
const BOTH_MODES =
  "stream and background can't both be true: follow a background run on its stream route";
const StartRun = z.object({ agent: z.string(), input: z.unknown() });
const Decision = z.union([
  z.object({ approved: z.literal(true) }),
  z.object({ approved: z.literal(false), reason: z.string().min(1).max(500) }),
  z.object({ approved: z.literal(false), changes: z.string().min(1).max(2_000) }),
]);

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { identity: Identity } }>();

  app.get("/health", (c) => c.json({ ok: true }));

  // Bearer token, or ?access_token= on the stream route, because EventSource can't send headers.
  const authenticate: MiddlewareHandler<{ Variables: { identity: Identity } }> = async (
    c,
    next,
  ) => {
    const header = c.req.header("authorization");
    const fromQuery = c.req.path.endsWith("/stream") ? c.req.query("access_token") : undefined;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : fromQuery;
    if (!token) return c.json({ error: "missing token" }, 401);
    try {
      c.set("identity", await verifyToken(token, deps.secret, deps.tenants));
    } catch {
      return c.json({ error: "invalid token" }, 401);
    }
    await next();
  };
  app.use("/runs", authenticate);
  app.use("/runs/*", authenticate);

  app.onError((err, c) => {
    if (err instanceof RunError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  const redactor = createRedactor();
  const sendEvent = (stream: SSEStreamingApi, e: RunEvent) =>
    stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
  const keepAlive = (stream: SSEStreamingApi) =>
    setInterval(() => void stream.write(": heartbeat\n\n"), deps.heartbeatMs ?? HEARTBEAT_MS);

  /** What an invocation ended with, as a response body; undefined if the run goes on elsewhere. */
  const outcome = (runId: string, end: InvocationEnd) => {
    switch (end.status) {
      case "completed":
      case "rejected":
        return { runId, status: end.status, output: redactor.value(end.output), usage: end.usage };
      case "failed":
        return {
          runId,
          status: end.status,
          reason: end.reason,
          message: end.message,
          usage: end.usage,
        };
      case "waiting": {
        const { callId, tool, input } = end.approval;
        const approval = { callId, tool, input: redactor.value(input) };
        return { runId, status: end.status, approval, usage: end.usage };
      }
      default:
        return undefined;
    }
  };

  /** Answers a request that started or resumed `runId`, in the mode it asked for. */
  const respond = async (
    c: Context,
    runId: string,
    invocation: { ended: Promise<InvocationEnd>; afterSeq: number },
    mode: { stream: boolean; background: boolean },
  ) => {
    if (mode.background) return c.json({ runId, status: "running" }, 202);
    if (mode.stream) {
      return streamSSE(c, async (stream) => {
        // the response ends with the invocation; the run's own stream route outlives it
        const ended = new AbortController();
        stream.onAbort(() => ended.abort());
        void invocation.ended.finally(() => ended.abort());
        const heartbeat = keepAlive(stream);
        let last = invocation.afterSeq;
        try {
          for await (const e of deps.events.follow(runId, last, ended.signal)) {
            await sendEvent(stream, e);
            last = e.seq;
          }
          // events written as the invocation ended
          if (!stream.aborted) {
            for (const e of await deps.events.read(runId, last)) await sendEvent(stream, e);
          }
        } finally {
          clearInterval(heartbeat);
        }
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), deps.maxWaitMs ?? MAX_WAIT_MS);
    });
    const end = await Promise.race([invocation.ended, timeout]).finally(() => clearTimeout(timer));
    const body = end && outcome(runId, end);
    // still going after the wait, or carried on by another process: follow it by its id
    return body ? c.json(body) : c.json({ runId, status: "running" }, 202);
  };

  /** The mode a request asked for, the agent's default deciding `stream` when it didn't say. */
  const modeOf = (requested: z.infer<typeof ResponseMode>, agentStreams: boolean) => ({
    stream: requested.stream ?? (!requested.background && agentStreams),
    background: requested.background ?? false,
  });

  const findRun = (tenantId: string, runId: string) =>
    withTenant(deps.pool, tenantId, async (db) => {
      const { rows } = await db.query(
        "select id, agent_id, status, input, result, created_at, updated_at from runs where id = $1",
        [runId],
      );
      return rows[0] as
        | { id: string; agent_id: string; status: string; input: unknown; result: unknown }
        | undefined;
    });

  app.post("/runs", async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const body = StartRun.safeParse(raw);
    if (!body.success) return c.json({ error: "expected { agent, input }" }, 400);
    const requested = ResponseMode.safeParse(raw);
    if (!requested.success) return c.json({ error: BOTH_MODES }, 400);
    const { tenantId } = c.get("identity");
    const { runId, ended } = await deps.runs.start(tenantId, body.data.agent, body.data.input);
    const mode = modeOf(requested.data, deps.runs.streams(body.data.agent));
    return respond(c, runId, { ended, afterSeq: 0 }, mode);
  });

  app.get("/runs/:id", async (c) => {
    const run = await findRun(c.get("identity").tenantId, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.get("/runs/:id/stream", async (c) => {
    const { tenantId } = c.get("identity");
    const runId = c.req.param("id");
    const run = await findRun(tenantId, runId);
    if (!run) return c.json({ error: "not found" }, 404);
    const after = Number.parseInt(
      c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? "0",
      10,
    );
    const afterSeq = Number.isFinite(after) && after > 0 ? after : 0;

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const heartbeat = keepAlive(stream);
      const send = (e: RunEvent) => sendEvent(stream, e);
      try {
        // finished runs whose live stream has expired replay from Postgres (without tokens)
        if (run.status !== "running" && !(await deps.events.exists(runId))) {
          for (const e of await readStoredEvents(deps.pool, tenantId, runId, afterSeq))
            await send(e);
          return;
        }
        for await (const e of deps.events.follow(runId, afterSeq, abort.signal)) await send(e);
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  app.post("/runs/:id/approvals/:callId", async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const decision = Decision.safeParse(raw);
    if (!decision.success) {
      return c.json(
        { error: "expected { approved: true } or { approved: false, reason | changes }" },
        400,
      );
    }
    const requested = ResponseMode.safeParse(raw);
    if (!requested.success) return c.json({ error: BOTH_MODES }, 400);
    const { tenantId, subject } = c.get("identity");
    const runId = c.req.param("id");
    const resumed = await deps.runs.decide(
      tenantId,
      runId,
      c.req.param("callId"),
      decision.data.approved
        ? { approved: true, by: subject }
        : "changes" in decision.data
          ? { approved: false, by: subject, changes: decision.data.changes }
          : { approved: false, by: subject, reason: decision.data.reason },
    );
    if (!resumed) return c.json({ error: "no pending approval" }, 404);
    // the decision resumes the run; the response follows it like the one that started it
    return respond(c, runId, resumed, modeOf(requested.data, deps.runs.streams(resumed.agentId)));
  });

  return app;
}
