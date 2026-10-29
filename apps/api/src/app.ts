import type { RunEvent } from "@dugout/contracts";
import type { TenantRegistry } from "@dugout/core";
import { type Pool, withTenant } from "@dugout/db";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type Identity, verifyToken } from "./auth.ts";
import { readStoredEvents, type ValkeyEventLog } from "./event-log.ts";
import { RunError, type RunManager } from "./runs.ts";

/** Keeps CloudFront and the ALB from closing quiet streams in production. */
export const HEARTBEAT_MS = 15_000;

export interface AppDeps {
  pool: Pool;
  runs: RunManager;
  events: ValkeyEventLog;
  tenants: TenantRegistry;
  secret: string;
  heartbeatMs?: number;
}

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
    const body = StartRun.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "expected { agent, input }" }, 400);
    const { tenantId } = c.get("identity");
    const runId = await deps.runs.start(tenantId, body.data.agent, body.data.input);
    return c.json({ runId }, 202);
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
      const heartbeat = setInterval(() => {
        void stream.write(": heartbeat\n\n");
      }, deps.heartbeatMs ?? HEARTBEAT_MS);
      const send = (e: RunEvent) =>
        stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
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
    const decision = Decision.safeParse(await c.req.json().catch(() => undefined));
    if (!decision.success) {
      return c.json(
        { error: "expected { approved: true } or { approved: false, reason | changes }" },
        400,
      );
    }
    const { tenantId, subject } = c.get("identity");
    const ok = await deps.runs.decide(
      tenantId,
      c.req.param("id"),
      c.req.param("callId"),
      decision.data.approved
        ? { approved: true, by: subject }
        : "changes" in decision.data
          ? { approved: false, by: subject, changes: decision.data.changes }
          : { approved: false, by: subject, reason: decision.data.reason },
    );
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval" }, 404);
  });

  return app;
}
