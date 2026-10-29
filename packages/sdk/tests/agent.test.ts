import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type RunEvent } from "@dugout/contracts";
import { createMemorySink, createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

// a tenant of its own, so facts seeded here don't meet other tests' facts
const tenant = `sdk-${randomUUID().slice(0, 6)}`;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdk-agent-"));
  await mkdir(join(dir, "skills"));
  await writeFile(join(dir, "skills", "notes.md"), "Keep titles under five words.");
  await mkdir(join(dir, "data", tenant), { recursive: true });
  await writeFile(
    join(dir, "data", tenant, "style.json"),
    JSON.stringify({ facts: [{ key: "notes.case", content: "Titles use sentence case." }] }),
  );
});

/** The smallest useful agent: saves a note after approval and ends with its title. */
const notes = () =>
  defineAgent({
    spec: {
      id: "notes",
      version: 1,
      owner: "test",
      instructions: "Save one note for the topic, then call final with its title.",
      tools: ["notes.save"],
      skills: ["notes"],
      model: { tier: "smart" },
      memory: { read: ["procedural", "semantic"], write: [] },
      budget: { usdPerRun: 1, maxSteps: 5, maxDepth: 0 },
      approvals: ["effect:write"],
    },
    input: z.object({ topic: z.string().min(1) }),
    output: z.object({ title: z.string() }),
    dir,
    tools: (opts: { notesDir: string }) => [
      defineTool({
        name: "notes.save",
        description: "Saves a note.",
        input: z.object({ title: z.string() }),
        effect: "write",
        timeoutMs: 1_000,
        async run({ title }, ctx) {
          await writeFile(join(opts.notesDir, `${ctx.tenantId}.txt`), title);
          return { saved: true };
        },
      }),
    ],
  });

const script = () =>
  createScriptedModel([
    { toolCalls: [{ name: "notes.save", arguments: { title: "Season opener" } }] },
    { toolCalls: [{ name: "final", arguments: { title: "Season opener" } }] },
  ]);

describe("defineAgent", () => {
  it("runs an agent from its definition: skill and house facts in, approval, output out", async () => {
    const agent = notes();
    expect(await agent.seed(store, [tenant, "no-data-tenant"])).toEqual({ [tenant]: 1 });
    expect(await agent.seed(store, [tenant])).toEqual({ [tenant]: 0 });

    const notesDir = await mkdtemp(join(tmpdir(), "notes-"));
    const client = script();
    const traced: RunEvent[] = [];
    const run = agent.create({
      store,
      client,
      models: scriptedModelConfig(),
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      tracing: { sink: () => ({ write: (e) => void traced.push(e) }) },
      notesDir,
    });
    const sink = createMemorySink();
    const result = await run({
      tenantId: tenant,
      input: { topic: "the opener" },
      approver: async () => ({ approved: true, by: "editor" }),
      sinks: [sink],
    });

    expect(result).toMatchObject({ status: "completed", output: { title: "Season opener" } });
    expect(await readFile(join(notesDir, `${tenant}.txt`), "utf8")).toBe("Season opener");
    const system = client.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("Keep titles under five words.");
    expect(system).toContain("Titles use sentence case.");
    expect(sink.events.map((e) => e.type)).toContain("approval.granted");
    // the host's tracing sink sees the same run
    expect(traced.map((e) => e.seq)).toEqual(sink.events.map((e) => e.seq));
  });

  it("refuses input that doesn't match the agent's schema", async () => {
    const run = notes().create({
      store,
      client: script(),
      models: scriptedModelConfig(),
      notesDir: dir,
    });
    expect(() =>
      run({
        tenantId: tenant,
        input: { topic: "" },
        approver: async () => ({ approved: true, by: "x" }),
      }),
    ).toThrow();
  });

  it("refuses a spec that lists a tool the agent doesn't have", () => {
    const agent = defineAgent({
      ...notes(),
      spec: { ...notes().spec, tools: ["notes.save", "notes.delete"] },
      dir,
      tools: () => [],
    });
    expect(() => agent.create({ store, client: script(), models: scriptedModelConfig() })).toThrow(
      "notes: spec.tools lists notes.save, notes.delete, but no such tool",
    );
  });

  it("checks the spec when the agent is defined", () => {
    expect(() =>
      defineAgent({
        ...notes(),
        spec: { ...notes().spec, budget: { usdPerRun: -1, maxSteps: 5, maxDepth: 0 } },
        dir,
        tools: () => [],
      }),
    ).toThrow();
  });
});
