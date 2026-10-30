import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type RunEvent } from "@dugout/contracts";
import {
  createBedrockClient,
  createMemorySink,
  createScriptedModel,
  loadModelConfig,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { defineAgent, seedHouseFacts } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

// a tenant of its own, so facts seeded here don't meet other tests' facts
const tenant = `sdk-${randomUUID().slice(0, 6)}`;
let dir: string;
let tenantsDir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdk-agent-"));
  await mkdir(join(dir, "skills"));
  await writeFile(join(dir, "skills", "notes.md"), "Keep titles under five words.");
  await writeFile(
    join(dir, "skills", "headlines.md"),
    "---\ndescription: How to write a headline\n---\nPut the team first.",
  );
  tenantsDir = await mkdtemp(join(tmpdir(), "sdk-tenants-"));
  await mkdir(join(tenantsDir, tenant));
  await writeFile(
    join(tenantsDir, tenant, "facts.json"),
    JSON.stringify({
      facts: [
        { key: "style.case", content: "Titles use sentence case." },
        { key: "notes.topic", content: "Notes: name the topic in the title." },
      ],
    }),
  );
});

/** The smallest useful agent: saves a note after approval and ends with its title. */
const notes = (extra: { tools?: string[]; onDemandSkills?: string[] } = {}) =>
  defineAgent({
    spec: {
      id: "notes",
      version: 1,
      owner: "test",
      instructions: "Save one note for the topic, then call final with its title.",
      tools: ["notes.save", ...(extra.tools ?? [])],
      skills: ["notes"],
      onDemandSkills: extra.onDemandSkills ?? [],
      model: "nova-lite",
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
    expect(await seedHouseFacts(store, [tenant, "no-data-tenant"], tenantsDir)).toEqual([
      { tenantId: tenant, changed: 2 },
    ]);
    expect(await seedHouseFacts(store, [tenant], tenantsDir)).toEqual([
      { tenantId: tenant, changed: 0 },
    ]);

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
    // every fact of the tenant
    expect(system).toContain("Titles use sentence case.");
    expect(system).toContain("Notes: name the topic in the title.");
    expect(sink.events.map((e) => e.type)).toContain("approval.granted");
    // the host's tracing sink sees the same run
    expect(traced.map((e) => e.seq)).toEqual(sink.events.map((e) => e.seq));
  });

  it("lists the skills there are to load, and the agent loads one when it needs it", async () => {
    const client = createScriptedModel([
      { toolCalls: [{ name: "skill.load", arguments: { name: "headlines" } }] },
      { toolCalls: [{ name: "final", arguments: { title: "Lions first" } }] },
    ]);
    const run = notes({ tools: ["skill.load"], onDemandSkills: ["headlines"] }).create({
      store,
      client,
      models: scriptedModelConfig(),
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      notesDir: dir,
    });
    const result = await run({
      tenantId: tenant,
      input: { topic: "the opener" },
      approver: async () => ({ approved: true, by: "editor" }),
    });

    expect(result.status).toBe("completed");
    const system = client.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("## Skills you can load");
    expect(system).toContain("- headlines: How to write a headline");
    expect(system).not.toContain("Put the team first.");
    expect(client.requests[1]?.messages.at(-1)?.content).toBe(
      "## Skill: headlines\n\nPut the team first.",
    );
  });

  it("asks for the shared memory of the sports a run's input names", async () => {
    const asked: Array<[string, string[] | undefined]> = [];
    const agent = defineAgent({
      spec: { ...notes().spec, tools: [] },
      input: z.object({ topic: z.string(), sports: z.array(z.string()).optional() }),
      output: z.object({ title: z.string() }),
      dir,
      tools: () => [],
      sportsOf: (input) => input.sports,
    });
    const run = agent.create({
      store,
      client: createScriptedModel([
        { toolCalls: [{ name: "final", arguments: { title: "Swim meet" } }] },
      ]),
      models: scriptedModelConfig(),
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      memoryGroups: (tenantId, sports) => {
        asked.push([tenantId, sports]);
        return ["global"];
      },
    });
    await run({
      tenantId: tenant,
      input: { topic: "the meet", sports: ["swimming"] },
      approver: async () => ({ approved: true, by: "editor" }),
    });
    expect(asked).toContainEqual([tenant, ["swimming"]]);
  });

  it("runs two agents on two named models through one client, each with its model's id and effort", async () => {
    // stands in for Bedrock: every call ends the run through `final`
    const sent: Array<Record<string, unknown>> = [];
    const runtime = {
      async send(command: unknown) {
        sent.push((command as { input: Record<string, unknown> }).input);
        const start = { toolUse: { toolUseId: `t${sent.length}`, name: "final" } };
        const input = '{"title":"Opener"}';
        return {
          stream: (async function* () {
            yield { contentBlockStart: { contentBlockIndex: 0, start } };
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input } } } };
            yield { messageStop: { stopReason: "tool_use" } };
          })(),
        };
      },
    };
    const models = loadModelConfig();
    const deps = {
      store,
      client: createBedrockClient({ runtime, models }),
      models,
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      notesDir: dir,
    };
    for (const model of ["opus", "nova-2-lite"]) {
      const agent = defineAgent({
        spec: { ...notes().spec, tools: [], model },
        input: z.object({ topic: z.string() }),
        output: z.object({ title: z.string() }),
        dir,
        tools: () => [],
      });
      const result = await agent.create(deps)({
        tenantId: tenant,
        input: { topic: "the opener" },
        approver: async () => ({ approved: true, by: "editor" }),
      });
      expect(result.status).toBe("completed");
    }

    const [opus, nova] = sent;
    expect(opus).toMatchObject({
      modelId: "global.anthropic.claude-opus-5-5",
      outputConfig: { effort: "high" },
      inferenceConfig: { maxTokens: 128_000 },
    });
    expect(opus).not.toHaveProperty("additionalModelRequestFields");
    expect(nova).toMatchObject({
      modelId: "global.amazon.nova-2-lite-v1:0",
      additionalModelRequestFields: {
        reasoningConfig: { type: "enabled", maxReasoningEffort: "low" },
      },
      inferenceConfig: { maxTokens: 65_535 },
    });
    expect(nova).not.toHaveProperty("outputConfig");
  });

  it("runs on another model when the host names one, and refuses a name the list doesn't have", async () => {
    const client = script();
    const run = notes().create({
      store,
      client,
      models: scriptedModelConfig(),
      model: "haiku",
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      notesDir: await mkdtemp(join(tmpdir(), "notes-")),
    });
    await run({
      tenantId: tenant,
      input: { topic: "the opener" },
      approver: async () => ({ approved: true, by: "editor" }),
    });
    expect(client.requests.map((r) => r.model)).toEqual(["haiku", "haiku"]);
    expect(() =>
      notes().create({ store, client, models: scriptedModelConfig(), model: "gpt", notesDir: dir }),
    ).toThrow("no model named gpt");
  });

  it("needs skill.load for skills on demand, and each skill in one list only", () => {
    expect(() => notes({ onDemandSkills: ["headlines"] })).toThrow(
      "onDemandSkills needs skill.load",
    );
    expect(() => notes({ tools: ["skill.load"], onDemandSkills: ["notes"] })).toThrow(
      "notes in both",
    );
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
