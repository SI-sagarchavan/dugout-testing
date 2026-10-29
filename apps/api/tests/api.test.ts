import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent as matchPreview } from "@dugout/agent-match-preview";
import { agent as sitemap } from "@dugout/agent-sitemap";
import type { RunEvent } from "@dugout/contracts";
import { createScriptedModel, loadTenants, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp, createRunManager, createValkeyEventLog, issueToken } from "../src/index.ts";
import { sitemapWriter, writer } from "./fixtures.ts";

const SECRET = "test-secret";
const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
let runsDir: string;

const runs = createRunManager({
  pool,
  events,
  agents: {
    "match-preview": {
      input: matchPreview.input,
      // as defineAgent sets them: text answers stream, structured output waits
      stream: matchPreview.stream,
      run: (opts) =>
        matchPreview.create({
          store,
          client: createScriptedModel(writer()),
          models: scriptedModelConfig(),
          runsDir,
          draftsDir: join(runsDir, "drafts"),
          consolidate: false,
        })(opts),
    },
    sitemap: {
      input: sitemap.input,
      stream: sitemap.stream,
      run: (opts) =>
        sitemap.create({
          store,
          client: createScriptedModel(sitemapWriter()),
          models: scriptedModelConfig(),
          runsDir,
          sitemapsDir: join(runsDir, "sitemaps"),
          consolidate: false,
        })(opts),
    },
  },
});
const appDeps = { pool, runs, events, tenants: loadTenants(), secret: SECRET, heartbeatMs: 50 };
const app = createApp(appDeps);

let cricket: string;
let football: string;
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "api-runs-"));
  await matchPreview.seed(store, ["demo-cricket", "demo-football"]);
  await sitemap.seed(store, ["demo-cricket", "demo-football"]);
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
  return readEvents(await app.request(path, { headers }), until);
}

/** The SSE events in a response, until `until` returns true or the response ends. */
async function readEvents(res: Response, until: (e: RunEvent) => boolean = () => false) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
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
    body: JSON.stringify({
      agent: "match-preview",
      input: { fixtureId: "c-101" },
      background: true,
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
};

const approve = (runId: string, callId: string, token = cricket) =>
  app.request(`/runs/${runId}/approvals/${callId}`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ approved: true, background: true }),
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
    expect((await approve(runId, request.data.callId)).status).toBe(202);
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
    expect((await approve(runId, callId)).status).toBe(202);
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
    expect(stored.every((e) => e.type !== "token" && e.type !== "tool.input.delta")).toBe(true);
    expect(stored.every((e) => e.seq > 2)).toBe(true);
    expect(stored.at(-1)?.type).toBe("run.completed");
  });

  it("sends requested changes back into the same run", async () => {
    const runId = await start();
    const seen = await readStream(
      `/runs/${runId}/stream`,
      auth(cricket),
      (e) => e.type === "approval.requested",
    );
    const request = seen.events.at(-1) as Extract<RunEvent, { type: "approval.requested" }>;
    const decide = (body: unknown) =>
      app.request(`/runs/${runId}/approvals/${request.data.callId}`, {
        method: "POST",
        headers: { ...auth(cricket), "content-type": "application/json" },
        body: JSON.stringify({ ...(body as object), background: true }),
      });
    expect((await decide({ approved: false })).status).toBe(400);
    expect((await decide({ approved: false, changes: "Name both captains." })).status).toBe(202);

    const rest = await readStream(
      `/runs/${runId}/stream`,
      { ...auth(cricket), "last-event-id": String(request.seq) },
      (e) => e.type === "approval.requested",
    );
    expect(rest.events.find((e) => e.type === "approval.changes_requested")).toMatchObject({
      data: { by: "editor-1", changes: "Name both captains.", callId: request.data.callId },
    });
    // the same run asks again with the changed draft
    const again = rest.events.at(-1) as Extract<RunEvent, { type: "approval.requested" }>;
    expect(again.type).toBe("approval.requested");
    expect(again.data.input).toMatchObject({ body: expect.stringContaining("captains") });
    expect((await approve(runId, again.data.callId)).status).toBe(202);
    const end = await readStream(`/runs/${runId}/stream`, {
      ...auth(cricket),
      "last-event-id": String(again.seq),
    });
    expect(end.events.some((e) => e.type === "approval.rejected")).toBe(false);
    expect(end.events.at(-1)).toMatchObject({
      type: "run.completed",
      data: { status: "completed" },
    });
  });

  it("serves the sitemap agent, with a change sent back into the run and the result returned", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: { ...auth(cricket), "content-type": "application/json" },
      body: JSON.stringify({
        agent: "sitemap",
        input: { brief: "A T20 club with a fan zone.", sports: ["cricket"] },
        background: true,
      }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    type Requested = Extract<RunEvent, { type: "approval.requested" }>;

    const first = await readStream(
      `/runs/${runId}/stream`,
      auth(cricket),
      (e) => e.type === "approval.requested",
    );
    const request = first.events.at(-1) as Requested;
    expect(request.data.tool).toBe("sitemap.save");
    const changed = await app.request(`/runs/${runId}/approvals/${request.data.callId}`, {
      method: "POST",
      headers: { ...auth(cricket), "content-type": "application/json" },
      body: JSON.stringify({
        approved: false,
        changes: "Use /fanzone for the Fan Zone.",
        background: true,
      }),
    });
    expect(changed.status).toBe(202);

    const second = await readStream(
      `/runs/${runId}/stream`,
      { ...auth(cricket), "last-event-id": String(request.seq) },
      (e) => e.type === "approval.requested",
    );
    const again = second.events.at(-1) as Requested;
    const fanZone = { name: "Fan Zone", url: "/fanzone" };
    expect(again.data.input).toMatchObject({ navigation: expect.arrayContaining([fanZone]) });
    expect((await approve(runId, again.data.callId)).status).toBe(202);

    const end = await readStream(`/runs/${runId}/stream`, {
      ...auth(cricket),
      "last-event-id": String(again.seq),
    });
    expect(end.events.at(-1)).toMatchObject({
      type: "run.completed",
      data: { status: "completed", output: { navigation: expect.arrayContaining([fanZone]) } },
    });
    const pages = await readFile(join(runsDir, "sitemaps", "demo-cricket", "pages.json"), "utf8");
    expect(pages).toContain('"slug": "fanzone"');
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

describe("response modes", () => {
  type Requested = Extract<RunEvent, { type: "approval.requested" }>;
  const post = (path: string, body: unknown, token = cricket) =>
    app.request(path, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const brief = { brief: "A T20 club with a fan zone.", sports: ["cricket"] };
  const fanZone = { name: "Fan Zone", url: "/fanzone" };

  it("answers in JSON when the response isn't streamed: a whole review without SSE", async () => {
    // the sitemap agent has an output schema, so its responses wait by default
    const first = await post("/runs", { agent: "sitemap", input: brief });
    expect(first.status).toBe(200);
    const waiting = (await first.json()) as {
      runId: string;
      status: string;
      approval: { callId: string; tool: string; input: unknown };
    };
    expect(waiting).toMatchObject({ status: "waiting", approval: { tool: "sitemap.save" } });
    const { runId } = waiting;

    const changed = await post(`/runs/${runId}/approvals/${waiting.approval.callId}`, {
      approved: false,
      changes: "Use /fanzone for the Fan Zone.",
    });
    expect(changed.status).toBe(200);
    const again = (await changed.json()) as typeof waiting;
    expect(again).toMatchObject({
      runId,
      status: "waiting",
      approval: { input: { navigation: expect.arrayContaining([fanZone]) } },
    });

    const approved = await post(`/runs/${runId}/approvals/${again.approval.callId}`, {
      approved: true,
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      runId,
      status: "completed",
      output: { navigation: expect.arrayContaining([fanZone]) },
      usage: { steps: expect.any(Number) },
    });
  });

  it("streams each invocation in its response, and the pieces join up without gaps", async () => {
    // match-preview answers in text, so its responses stream by default
    const first = await readEvents(
      await post("/runs", { agent: "match-preview", input: { fixtureId: "c-101" } }),
    );
    // the response ends where the run waits for a person
    expect(first.events.at(0)?.type).toBe("run.started");
    expect(first.events.some((e) => e.type === "token")).toBe(true);
    const request = first.events.at(-1) as Requested;
    expect(request.type).toBe("approval.requested");

    const rest = await readEvents(
      await post(`/runs/${request.runId}/approvals/${request.data.callId}`, { approved: true }),
    );
    expect(rest.events.at(0)).toMatchObject({ type: "run.resumed", data: { reason: "approval" } });
    expect(rest.events.at(-1)).toMatchObject({
      type: "run.completed",
      data: { status: "completed" },
    });
    const all = [...first.events, ...rest.events];
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });

  it("lets the request choose against the agent's default", async () => {
    const streamed = await readEvents(
      await post("/runs", { agent: "sitemap", input: brief, stream: true }),
    );
    const request = streamed.events.at(-1) as Requested;
    expect(request.type).toBe("approval.requested");
    // structured output streams as the tool call's arguments, before the call is made
    const fragments = streamed.events.flatMap((e) =>
      e.type === "tool.input.delta" && e.data.callId === request.data.callId ? [e.data.text] : [],
    );
    expect(JSON.parse(fragments.join(""))).toEqual(request.data.input);

    const waited = await post(`/runs/${request.runId}/approvals/${request.data.callId}`, {
      approved: true,
      stream: false,
    });
    expect(await waited.json()).toMatchObject({ status: "completed" });

    const preview = await post("/runs", {
      agent: "match-preview",
      input: { fixtureId: "c-101" },
      stream: false,
    });
    const waiting = (await preview.json()) as { runId: string; approval: { callId: string } };
    expect(waiting).toMatchObject({ status: "waiting", approval: { tool: "draft.save" } });
    await post(`/runs/${waiting.runId}/approvals/${waiting.approval.callId}`, {
      approved: false,
      reason: "not this week",
    });
  });

  it("answers 202 with the run id when the run takes longer than the request waits", async () => {
    const impatient = createApp({ ...appDeps, maxWaitMs: 1 });
    const res = await impatient.request("/runs", {
      method: "POST",
      headers: { ...auth(cricket), "content-type": "application/json" },
      body: JSON.stringify({ agent: "sitemap", input: brief }),
    });
    expect(res.status).toBe(202);
    const { runId, status } = (await res.json()) as { runId: string; status: string };
    expect(status).toBe("running");
    // it carries on, and can be followed by its id
    const { events: seen } = await readStream(
      `/runs/${runId}/stream`,
      auth(cricket),
      (e) => e.type === "approval.requested",
    );
    const callId = (seen.at(-1) as Requested).data.callId;
    expect((await post(`/runs/${runId}/approvals/${callId}`, { approved: true })).status).toBe(200);
  });

  it("refuses a request that asks to stream a background run", async () => {
    const res = await post("/runs", {
      agent: "sitemap",
      input: brief,
      stream: true,
      background: true,
    });
    expect(res.status).toBe(400);
  });
});
