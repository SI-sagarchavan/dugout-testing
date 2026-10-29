import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatchPreview, Input, seedHouseStyle } from "@dugout/agent-match-preview";
import type { ModelRequest, RunEvent } from "@dugout/contracts";
import {
  createScriptedModel,
  loadTenants,
  type ScriptedTurn,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp, createRunManager, createValkeyEventLog, issueToken } from "../src/index.ts";

const SECRET = "test-secret";
const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
let runsDir: string;

function writer(): Array<(req: ModelRequest) => ScriptedTurn> {
  let f: { home: string; away: string };
  return [
    () => ({
      content: "Looking up the fixture.",
      toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: "c-101" } }],
    }),
    (req) => {
      f = JSON.parse(req.messages.at(-1)?.content ?? "{}");
      return { toolCalls: [{ name: "team.stats", arguments: { teamId: f.home } }] };
    },
    () => ({
      toolCalls: [
        {
          name: "draft.save",
          arguments: {
            fixtureId: "c-101",
            title: "Mariners v Chargers",
            body: "A measured preview of both sides.",
          },
        },
      ],
    }),
    () => ({ content: "Saved." }),
  ];
}

const runs = createRunManager({
  pool,
  events,
  agents: {
    "match-preview": {
      input: Input,
      run: (opts) =>
        createMatchPreview({
          store,
          client: createScriptedModel(writer()),
          models: scriptedModelConfig(),
          runsDir,
          draftsDir: join(runsDir, "drafts"),
          consolidate: false,
        })(opts),
    },
  },
});
const app = createApp({
  pool,
  runs,
  events,
  tenants: loadTenants(),
  secret: SECRET,
  heartbeatMs: 50,
});

let cricket: string;
let football: string;
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "api-runs-"));
  await seedHouseStyle(store, ["demo-cricket", "demo-football"]);
  cricket = await issueToken({ secret: SECRET, subject: "editor-1", tenantId: "demo-cricket" });
  football = await issueToken({ secret: SECRET, subject: "editor-2", tenantId: "demo-football" });
});
afterAll(async () => {
  await runs.idle();
  await pool.end();
  valkey.disconnect();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Reads SSE events until `until` returns true or the stream ends, then cancels the request. */
async function readStream(
  path: string,
  headers: Record<string, string>,
  until: (e: RunEvent) => boolean = () => false,
) {
  const res = await app.request(path, { headers });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const out: RunEvent[] = [];
  let buffer = "";
  let heartbeats = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i = buffer.indexOf("\n\n");
    while (i !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (block.startsWith(":")) heartbeats++;
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data) {
        const event = JSON.parse(data.slice(6)) as RunEvent;
        out.push(event);
        if (until(event)) {
          await reader.cancel();
          return { events: out, heartbeats };
        }
      }
      i = buffer.indexOf("\n\n");
    }
  }
  return { events: out, heartbeats };
}

const start = async (token = cricket) => {
  const res = await app.request("/runs", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ agent: "match-preview", input: { fixtureId: "c-101" } }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
};

const approve = (runId: string, callId: string, token = cricket) =>
  app.request(`/runs/${runId}/approvals/${callId}`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ approved: true }),
  });

describe("api", () => {
  it("rejects missing and invalid tokens", async () => {
    expect((await app.request("/runs", { method: "POST" })).status).toBe(401);
    expect((await app.request("/runs/x", { headers: auth("nope") })).status).toBe(401);
    const forged = await issueToken({ secret: "other", subject: "x", tenantId: "demo-cricket" });
    expect((await app.request("/runs/x", { headers: auth(forged) })).status).toBe(401);
  });

  it("runs to completion through an approval, and resumes from any event id without gaps or duplicates", async () => {
    const runId = await start();

    // first connection drops right after the approval request
    const first = await readStream(
      `/runs/${runId}/stream`,
      auth(cricket),
      (e) => e.type === "approval.requested",
    );
    const request = first.events.at(-1) as Extract<RunEvent, { type: "approval.requested" }>;
    expect(request.data.input).toMatchObject({ fixtureId: "c-101" });

    expect((await approve(runId, request.data.callId, football)).status).toBe(404);
    expect((await approve(runId, request.data.callId)).status).toBe(200);
    expect((await approve(runId, request.data.callId)).status).toBe(404);

    // reconnect with Last-Event-ID and read to the end
    const rest = await readStream(`/runs/${runId}/stream`, {
      ...auth(cricket),
      "last-event-id": String(request.seq),
    });
    const all = [...first.events, ...rest.events];
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.at(-1)).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(all.find((e) => e.type === "approval.granted")).toMatchObject({
      data: { by: "editor-1" },
    });
    expect(all.some((e) => e.type === "token")).toBe(true);

    for (let k = 0; k <= all.length; k++) {
      const resumed = await readStream(`/runs/${runId}/stream?lastEventId=${k}`, auth(cricket));
      expect(resumed.events.map((e) => e.seq)).toEqual(all.slice(k).map((e) => e.seq));
    }

    const run = await app.request(`/runs/${runId}`, { headers: auth(cricket) });
    expect(await run.json()).toMatchObject({
      id: runId,
      status: "completed",
      agent_id: "match-preview",
    });
  });

  it("hides one tenant's runs from another", async () => {
    const runId = await start();
    expect((await app.request(`/runs/${runId}`, { headers: auth(football) })).status).toBe(404);
    expect((await app.request(`/runs/${runId}/stream`, { headers: auth(football) })).status).toBe(
      404,
    );
    const { events: seen } = await readStream(
      `/runs/${runId}/stream`,
      auth(cricket),
      (e) => e.type === "approval.requested",
    );
    const callId = (seen.at(-1) as Extract<RunEvent, { type: "approval.requested" }>).data.callId;
    expect((await approve(runId, callId)).status).toBe(200);
    await runs.idle();
  });

  it("accepts the token as a query parameter on the stream route only", async () => {
    const runId = await start();
    const { events: seen } = await readStream(
      `/runs/${runId}/stream?access_token=${cricket}`,
      {},
      (e) => e.type === "approval.requested",
    );
    expect(seen[0]?.type).toBe("run.started");
    expect((await app.request(`/runs/${runId}?access_token=${cricket}`)).status).toBe(401);
    await approve(
      runId,
      (seen.at(-1) as Extract<RunEvent, { type: "approval.requested" }>).data.callId,
    );
    await runs.idle();
  });

  it("replays a finished run from Postgres once its live stream has expired", async () => {
    const runId = await start();
    const { events: live } = await readStream(
      `/runs/${runId}/stream`,
      auth(cricket),
      (e) => e.type === "approval.requested",
    );
    await approve(
      runId,
      (live.at(-1) as Extract<RunEvent, { type: "approval.requested" }>).data.callId,
    );
    await runs.idle();
    await valkey.del(`run:${runId}:events`);

    const { events: stored } = await readStream(
      `/runs/${runId}/stream?lastEventId=2`,
      auth(cricket),
    );
    expect(stored.length).toBeGreaterThan(3);
    expect(stored.every((e) => e.type !== "token" && e.seq > 2)).toBe(true);
    expect(stored.at(-1)?.type).toBe("run.completed");
  });

  it("validates the agent and its input", async () => {
    const post = (body: unknown) =>
      app.request("/runs", {
        method: "POST",
        headers: { ...auth(cricket), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ agent: "nope", input: {} })).status).toBe(404);
    expect((await post({ agent: "match-preview", input: { fixture: 1 } })).status).toBe(400);
  });

  it("sends heartbeats while a run waits", async () => {
    const runId = await start();
    let approvalSeen = false;
    const res = await readStream(`/runs/${runId}/stream`, auth(cricket), (e) => {
      if (e.type === "approval.requested") approvalSeen = true;
      return approvalSeen;
    });
    const callId = (res.events.at(-1) as Extract<RunEvent, { type: "approval.requested" }>).data
      .callId;
    await new Promise((r) => setTimeout(r, 120));
    const waiting = await (async () => {
      const r = await app.request(`/runs/${runId}/stream?lastEventId=${res.events.at(-1)?.seq}`, {
        headers: auth(cricket),
      });
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      const { value } = await reader.read();
      await reader.cancel();
      return new TextDecoder().decode(value);
    })();
    expect(waiting).toContain(": heartbeat");
    await approve(runId, callId);
    await runs.idle();
  });
});
