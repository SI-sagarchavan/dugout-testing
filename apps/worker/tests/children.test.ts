import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ModelClient, type RunEvent } from "@dugout/contracts";
import { createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { childRunId, defineAgent } from "@dugout/sdk";
import { Valkey } from "iovalkey";
import { afterAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { createRunQueue, createValkeyEventLog, createWorker, hostAgents } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const memory = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const events = createValkeyEventLog(valkey);
const queue = createRunQueue({ pool, events });
const TENANT = "demo-cricket";
afterAll(async () => {
  await pool.end();
  valkey.disconnect();
});

const CHILD = "You look facts up.";
const PARENT = "You summarise.";
const dir = await mkdtemp(join(tmpdir(), "worker-children-"));

const looker = defineAgent({
  spec: {
    id: "looker",
    version: 1,
    owner: "test",
    description: "Looks one fact up.",
    instructions: CHILD,
    tools: ["facts.lookup"],
    skills: [],
    onDemandSkills: [],
    model: "nova-lite",
    memory: { read: [], write: [] },
    budget: { usdPerRun: 0.5, maxSteps: 4, maxDepth: 0 },
    approvals: [],
  },
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  dir,
  tools: () => [
    defineTool({
      name: "facts.lookup",
      description: "Looks a fact up.",
      input: z.object({}),
      effect: "read",
      timeoutMs: 1_000,
      run: async () => ({ fact: "Friday" }),
    }),
  ],
});

const summariser = defineAgent({
  spec: {
    id: "summariser",
    version: 1,
    owner: "test",
    instructions: PARENT,
    tools: [],
    skills: [],
    onDemandSkills: [],
    model: "nova-lite",
    memory: { read: [], write: [] },
    budget: { usdPerRun: 1, maxSteps: 4, maxDepth: 1 },
    approvals: [],
  },
  input: z.object({ topic: z.string() }),
  output: z.object({ summary: z.string() }),
  agents: [looker],
  dir,
  tools: () => [],
});

/** Parent and child share one model; each turn goes to the script whose system prompt it carries. */
const model = (): ModelClient => {
  const parent = createScriptedModel([
    { toolCalls: [{ name: "agent.looker", arguments: { question: "When?" } }] },
    { toolCalls: [{ name: "final", arguments: { summary: "Friday" } }] },
  ]);
  const child = createScriptedModel([
    { toolCalls: [{ name: "facts.lookup", arguments: {} }] },
    { toolCalls: [{ name: "final", arguments: { answer: "Friday" } }] },
  ]);
  return {
    complete: (req, onToken, onToolInput) =>
      (String(req.messages[0]?.content).startsWith(CHILD) ? child : parent).complete(
        req,
        onToken,
        onToolInput,
      ),
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(runId: string, done: (es: RunEvent[]) => boolean) {
  for (let i = 0; i < 200; i++) {
    const all = await events.read(runId, 0);
    if (done(all)) return all;
    await sleep(25);
  }
  throw new Error(`run ${runId} did not end`);
}

describe("child runs in the worker (ADR 0025)", () => {
  it("records a child as a run of its own, linked to its call, ended, and never claimed alone", async () => {
    const deps = {
      store: memory,
      client: model(),
      models: scriptedModelConfig(),
      runsDir: dir,
      consolidate: false,
    };
    // the worker serves the child too: still, it never claims a child row by itself
    const worker = createWorker({
      pool,
      events,
      agents: hostAgents(deps, summariser, looker),
      onError: (_, err) => {
        throw err;
      },
    });
    const runId = await queue.start(TENANT, "summariser", { topic: `t-${randomUUID()}` });
    await worker.poll();
    const parentEvents = await until(runId, (es) => es.at(-1)?.type === "run.completed");
    await worker.idle();

    const done = parentEvents.find((e) => e.type === "tool.completed");
    const childId = childRunId(runId, "call_1_0");
    expect(done).toMatchObject({ data: { tool: "agent.looker", ok: true } });
    expect(
      JSON.parse((done as Extract<RunEvent, { type: "tool.completed" }>).data.content),
    ).toEqual({
      runId: childId,
      output: { answer: "Friday" },
    });

    const rows = await withTenant(pool, TENANT, async (db) => {
      const { rows } = await db.query(
        `select id, agent_id, status, parent_run_id, parent_call_id, result -> 'output' as output,
           (select count(*)::int from run_events e where e.run_id = r.id) as events,
           (select count(*)::int from run_checkpoint_history h where h.run_id = r.id) as saves
         from runs r where id = $1`,
        [childId],
      );
      return rows;
    });
    expect(rows).toEqual([
      expect.objectContaining({
        agent_id: "looker",
        status: "completed",
        parent_run_id: runId,
        parent_call_id: "call_1_0",
        output: { answer: "Friday" },
      }),
    ]);
    expect(rows[0].events).toBeGreaterThan(3);
    expect(rows[0].saves).toBeGreaterThan(3);
    // its own live stream, which a host can attach to
    expect((await events.read(childId, 0)).at(-1)?.type).toBe("run.completed");

    // a child left running with its lease run out is still never claimed on its own
    await withTenant(pool, TENANT, (db) =>
      db.query(
        "update runs set status = 'running', lease_until = now() - interval '1 minute' where id = $1",
        [childId],
      ),
    );
    expect(await worker.poll()).not.toContain(childId);
  });
});
