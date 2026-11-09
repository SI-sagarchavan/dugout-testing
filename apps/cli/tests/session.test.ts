import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@dugout/contracts";
import { createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { type AnyAgent, seedHouseFacts } from "@dugout/sdk";
import { drafter } from "@dugout/sdk/testing";
import {
  type AgentEntry,
  createRunQueue,
  createValkeyEventLog,
  createWorker,
} from "@dugout/worker";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { followRun, type Terminal } from "../src/session.ts";
import { askingWriter, writer } from "./fixtures.ts";

const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
const queue = createRunQueue({ pool, events });
const TENANT = "demo-cricket";
let runsDir: string;

/** The drafter's script; a test that wants it to ask first swaps in `askingWriter`. */
let drafterScript = writer;
const agents: Record<string, AgentEntry> = {
  drafter: {
    input: drafter.input,
    run: (opts) =>
      drafter.create({
        store,
        client: createScriptedModel(drafterScript()),
        models: scriptedModelConfig(),
        runsDir,
        draftsDir: join(runsDir, "drafts"),
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
const contiguous = (es: RunEvent[]) =>
  expect(es.map((e) => e.seq)).toEqual(es.map((_, i) => i + 1));

describe("the CLI", () => {
  it("follows a run a worker carries out, through its approval to the end", async () => {
    const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
    const { terminal, asked, text } = scripted(["y"]);
    const ending = await follow(drafter, runId, terminal);

    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toHaveLength(1);
    // the model's text as it streamed, the tools it called, and the draft as a reviewer reads it
    expect(text()).toContain("Looking up the topic.");
    expect(text()).toContain("· topics.get");
    expect(text()).toContain("── Draft for t-101");
    expect(text()).toContain("· resumed by a worker (answered)");
    contiguous(await events.read(runId, 0));
  });

  it("approves without asking when told to, and records that it did", async () => {
    const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
    const { terminal, asked, text } = scripted([]);
    const ending = await follow(drafter, runId, terminal, { autoApprove: true });

    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toHaveLength(0);
    expect(text()).toContain("approved without asking");
    const decided = (await events.read(runId, 0)).find((e) => e.type === "question.answered");
    expect(decided).toMatchObject({ data: { by: "editor (auto)" } });
  });

  it("rejects with a reason", async () => {
    const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
    const { terminal, asked } = scripted(["n", "not this week"]);
    const ending = await follow(drafter, runId, terminal);
    expect(asked).toEqual([expect.stringContaining("y approve"), "Reason for rejecting: "]);
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "rejected" } });
  });

  it("replays an ended run from Postgres once its live stream has expired", async () => {
    const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
    await follow(drafter, runId, scripted(["y"]).terminal);
    // the live stream gets the last event just before the permanent record does
    for (let i = 0; i < 100 && (await queue.find(TENANT, runId))?.status !== "completed"; i++) {
      await sleep(10);
    }
    await valkey.del(`run:${runId}:events`);

    const { terminal, asked, text } = scripted([]);
    const ending = await follow(drafter, runId, terminal, { afterSeq: 2 });
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toHaveLength(0);
    // the permanent record has no streamed text
    expect(text()).not.toContain("Looking up the topic.");
    expect(text()).toContain("· topics.get");
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
    const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
    const { terminal, asked } = scripted([]);
    const seen: string[] = [];
    terminal.choose = async (message, options) => {
      seen.push(message, ...options.map((option) => option.value));
      return "approve";
    };
    const ending = await follow(drafter, runId, terminal);
    expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
    expect(asked).toEqual([]);
    expect(seen).toEqual(["This step needs a decision", "approve", "reject", "change"]);
  });

  it("asks a run's questions one by one and submits the answers together (ADR 0029)", async () => {
    drafterScript = askingWriter;
    try {
      const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
      // tone: option 2; title: Enter takes the proposal; then the save's approval
      const { terminal, asked, text } = scripted(["2", "", "y"]);
      const ending = await follow(drafter, runId, terminal);

      expect(ending).toMatchObject({ type: "run.completed", data: { status: "completed" } });
      expect(asked).toHaveLength(3);
      expect(text()).toContain("ask has 2 questions");
      expect(text()).toContain("Which tone should the draft take?");
      expect(text()).toContain("The brief does not say");
      const answered = (await events.read(runId, 0)).find((e) => e.type === "question.answered");
      expect(answered).toMatchObject({
        data: { by: "editor", answers: { tone: "excited", title: "Season opener" } },
      });
      contiguous(await events.read(runId, 0));
    } finally {
      drafterScript = writer;
    }
  });

  it("answers with the proposals when told not to ask", async () => {
    drafterScript = askingWriter;
    try {
      const runId = await queue.start(TENANT, "drafter", { topicId: "t-101" });
      const { terminal, asked, text } = scripted([]);
      const ending = await follow(drafter, runId, terminal, { autoApprove: true });

      expect(ending).toMatchObject({ type: "run.completed" });
      expect(asked).toHaveLength(0);
      expect(text()).toContain("answered with the proposals: tone, title");
      const answered = (await events.read(runId, 0)).find((e) => e.type === "question.answered");
      expect(answered).toMatchObject({
        data: { by: "editor (auto)", answers: { tone: "measured", title: "Season opener" } },
      });
    } finally {
      drafterScript = writer;
    }
  });

  it("says when no worker has picked the run up", async () => {
    const runId = await queue.start(TENANT, "no-worker-runs-this", {});
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const { terminal, text } = scripted([]);
    const ending = await follow(drafter, runId, terminal, { signal: stop.signal, hintMs: 50 });
    expect(ending).toBeUndefined();
    expect(text()).toContain("no worker has picked the run up yet; start one: pnpm worker");
  });
});
