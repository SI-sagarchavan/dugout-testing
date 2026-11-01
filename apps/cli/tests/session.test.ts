import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent as matchPreview } from "@dugout/agent-match-preview";
import { agent as sitemap } from "@dugout/agent-sitemap";
import type { RunEvent } from "@dugout/contracts";
import { createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { type AnyAgent, seedHouseFacts } from "@dugout/sdk";
import {
  type AgentEntry,
  createRunQueue,
  createValkeyEventLog,
  createWorker,
} from "@dugout/worker";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { followRun, type Terminal } from "../src/session.ts";
import { sitemapWriter, writer } from "./fixtures.ts";

const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
const queue = createRunQueue({ pool, events });
const TENANT = "demo-cricket";
let runsDir: string;

const agents: Record<string, AgentEntry> = {
  "match-preview": {
    input: matchPreview.input,
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
};
// as in production, the worker runs the agents; the CLI only queues and follows
const worker = createWorker({ pool, events, agents, onError: (id, err) => console.error(id, err) });

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "cli-runs-"));
  await seedHouseFacts(store, [TENANT]);
  worker.start(20);
});
afterAll(async () => {
  await worker.stop();
  await pool.end();
  valkey.disconnect();
});

/** A terminal that answers prompts from a list and keeps what was shown, without colours. */
function scripted(answers: string[]) {
  const out: string[] = [];
  const asked: string[] = [];
  const terminal: Terminal = {
    write: (text) => void out.push(text),
    line: (text) => void out.push(`${text}\n`),
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the terminal's colour codes
  const text = () => out.join("").replace(/\x1b\[[0-9;]*m/g, "");
  return { terminal, asked, text };
}

const follow = (
  agent: AnyAgent,
  runId: string,
  terminal: Terminal,
  opts: { afterSeq?: number; signal?: AbortSignal; hintMs?: number; autoApprove?: boolean } = {},
) =>
  followRun({
    queue,
    agent,
    tenantId: TENANT,
    runId,
    terminal,
    by: "editor",
    signal: opts.signal ?? new AbortController().signal,
    ...(opts.afterSeq !== undefined ? { afterSeq: opts.afterSeq } : {}),
    ...(opts.hintMs !== undefined ? { hintMs: opts.hintMs } : {}),
    ...(opts.autoApprove ? { autoApprove: true } : {}),
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventsUntil(runId: string, done: (events: RunEvent[]) => boolean) {
  for (let i = 0; i < 200; i++) {
    const all = await events.read(runId, 0);
    if (done(all)) return all;
    await sleep(25);
  }
  throw new Error(`run ${runId} did not get there`);
}
const approvals = (es: RunEvent[]) =>
  es.filter((e): e is Extract<RunEvent, { type: "approval.requested" }> => {
    return e.type === "approval.requested";
  });
const contiguous = (es: RunEvent[]) =>
  expect(es.map((e) => e.seq)).toEqual(es.map((_, i) => i + 1));
const brief = { brief: "A T20 club with a fan zone.", sports: ["cricket"] };
const fanZone = { name: "Fan Zone", url: "/fanzone" };

describe("the CLI", () => {
  it("follows a run a worker carries out, through its approval to the end", async () => {
    const runId = await queue.start(TENANT, "match-preview", { fixtureId: "c-101" });
    const { terminal, asked, text } = scripted(["y"]);
    const ending = await follow(matchPreview, runId, terminal);

    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toHaveLength(1);
    // the model's text as it streamed, the tools it called, and the draft as a reviewer reads it
    expect(text()).toContain("Looking up the fixture.");
    expect(text()).toContain("· fixtures.get");
    expect(text()).toContain("── Draft for c-101");
    expect(text()).toContain("· resumed by a worker (approval)");
    contiguous(await events.read(runId, 0));
  });

  it("approves without asking when told to, and records that it did", async () => {
    const runId = await queue.start(TENANT, "match-preview", { fixtureId: "c-101" });
    const { terminal, asked, text } = scripted([]);
    const ending = await follow(matchPreview, runId, terminal, { autoApprove: true });

    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toHaveLength(0);
    expect(text()).toContain("approved without asking");
    const decided = (await events.read(runId, 0)).find((e) => e.type === "approval.granted");
    expect(decided).toMatchObject({ data: { by: "editor (auto)" } });
  });

  it("sends a change back into the same run, and approves what comes back", async () => {
    const runId = await queue.start(TENANT, "sitemap", brief);
    const { terminal, asked, text } = scripted(["Use /fanzone for the Fan Zone.", "y"]);
    const ending = await follow(sitemap, runId, terminal);

    expect(asked).toHaveLength(2);
    expect(text()).toContain("skill sitemap (loaded in full)");
    expect(text()).toContain("Readers are T20 cricket followers.");
    expect(text()).toContain("· sent back for changes: Use /fanzone for the Fan Zone.");
    expect(ending).toMatchObject({
      type: "run.completed",
      data: { status: "completed", output: { navigation: expect.arrayContaining([fanZone]) } },
    });
    const pages = await readFile(join(runsDir, "sitemaps", TENANT, "pages.json"), "utf8");
    expect(pages).toContain('"slug": "fanzone"');
  });

  it("rejects with a reason", async () => {
    const runId = await queue.start(TENANT, "match-preview", { fixtureId: "c-101" });
    const { terminal, asked } = scripted(["n", "not this week"]);
    const ending = await follow(matchPreview, runId, terminal);
    expect(asked).toEqual([expect.stringContaining("y approve"), "Reason for rejecting: "]);
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "rejected" } });
  });

  it("attaches to a run already waiting, asking only about the approval still open", async () => {
    const runId = await queue.start(TENANT, "sitemap", brief);
    const [first] = approvals(await eventsUntil(runId, (es) => approvals(es).length === 1));
    const changes = { approved: false as const, by: "editor", changes: "Use /fanzone." };
    expect(await queue.decide(TENANT, runId, first?.data.callId ?? "", changes)).toBeDefined();
    await eventsUntil(runId, (es) => approvals(es).length === 2);

    // from the start: the first approval was decided before, so only the second is asked
    const { terminal, asked } = scripted(["y"]);
    const ending = await follow(sitemap, runId, terminal);
    expect(asked).toHaveLength(1);
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
  });

  it("replays an ended run from Postgres once its live stream has expired", async () => {
    const runId = await queue.start(TENANT, "match-preview", { fixtureId: "c-101" });
    await follow(matchPreview, runId, scripted(["y"]).terminal);
    // the live stream gets the last event just before the permanent record does
    for (let i = 0; i < 100 && (await queue.find(TENANT, runId))?.status !== "completed"; i++) {
      await sleep(10);
    }
    await valkey.del(`run:${runId}:events`);

    const { terminal, asked, text } = scripted([]);
    const ending = await follow(matchPreview, runId, terminal, { afterSeq: 2 });
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toHaveLength(0);
    // the permanent record has no streamed text
    expect(text()).not.toContain("Looking up the fixture.");
    expect(text()).toContain("· fixtures.get");
  });

  it("finds a run to attach to by the first characters of its id", async () => {
    const runId = await queue.start(TENANT, "no-worker-runs-this", {});
    expect((await queue.matching(TENANT, runId)).map((r) => r.id)).toEqual([runId]);
    expect((await queue.matching(TENANT, runId.slice(0, 8))).map((r) => r.id)).toContain(runId);
    expect((await queue.matching(TENANT, "")).at(0)?.id).toBe(runId);
    expect(await queue.matching(TENANT, "1zz")).toEqual([]);
    expect(await queue.matching(TENANT, "%")).toEqual([]);
    expect(await queue.matching("demo-football", runId)).toEqual([]);
  });

  it("asks with a menu when the terminal offers choices", async () => {
    const runId = await queue.start(TENANT, "match-preview", { fixtureId: "c-101" });
    const { terminal, asked } = scripted([]);
    const seen: string[] = [];
    terminal.choose = async (message, options) => {
      seen.push(message, ...options.map((option) => option.value));
      return "approve";
    };
    const ending = await follow(matchPreview, runId, terminal);
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toEqual([]);
    expect(seen).toEqual(["This step needs a decision", "approve", "reject", "change"]);
  });

  it("says when no worker has picked the run up", async () => {
    const runId = await queue.start(TENANT, "no-worker-runs-this", {});
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const { terminal, text } = scripted([]);
    const ending = await follow(matchPreview, runId, terminal, { signal: stop.signal, hintMs: 50 });
    expect(ending).toBeUndefined();
    expect(text()).toContain("no worker has picked the run up yet; start one: pnpm worker");
  });
});
