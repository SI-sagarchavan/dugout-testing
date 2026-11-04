import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createMcpHost, sha256, toolHash } from "@dugout/mcp";
import { fakeHub } from "@dugout/mcp/testing";
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const dir = mkdtempSync(join(tmpdir(), "sdk-capabilities-"));

// A registry of one server, "notes", and its lock: what `pnpm agent mcp sync` would have written
const tool = (name: string, description: string, readOnlyHint: boolean) => {
  const inputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
  const annotations = { readOnlyHint };
  return [
    name,
    {
      description,
      inputSchema,
      annotations,
      hash: toolHash({ name, description, inputSchema, annotations }),
    },
  ];
};
writeFileSync(
  join(dir, "notes.json"),
  JSON.stringify({
    id: "notes",
    title: "Notes",
    description: "A notes service",
    owner: "tests",
    environment: "test",
    transport: { type: "streamable-http", url: "http://notes.test/mcp" },
    auth: { type: "none" },
    tools: {
      notes_get: { effect: "read" },
      notes_save: { effect: "write" },
      notes_peek: { effect: "read", approval: "always" },
    },
    capabilities: {
      "notes.read": { description: "read", tools: { notes_get: {}, notes_peek: {} } },
      "notes.write": {
        description: "write",
        tools: { notes_save: { arguments: { id: "^mine_" } } },
      },
    },
  }),
);
writeFileSync(
  join(dir, "notes.lock.json"),
  JSON.stringify({
    server: "notes",
    syncedAt: "2026-11-04T00:00:00.000Z",
    serverInfo: { name: "notes", version: "1" },
    instructions: "Get a note before saving over it.",
    instructionsHash: sha256("Get a note before saving over it."),
    tools: Object.fromEntries([
      tool("notes_get", "Get a note", true),
      tool("notes_save", "Save a note", false),
      tool("notes_peek", "Peek at a note", true),
    ]),
  }),
);

const writer = (spec: { requires?: string[]; optional?: string[] }) =>
  defineAgent({
    spec: {
      id: "writer",
      version: 1,
      owner: "test",
      instructions: "You write notes.",
      tools: [],
      ...spec,
      skills: [],
      onDemandSkills: [],
      model: "nova-lite",
      memory: { read: [], write: [] },
      budget: { usdPerRun: 1, maxSteps: 4, maxDepth: 0 },
      approvals: [],
    },
    input: z.object({ topic: z.string() }),
    output: z.object({ id: z.string() }),
    dir,
    tools: () => [],
  });

describe("capabilities (ADR 0026)", () => {
  it("gives an agent the tools its capabilities grant, the server's guidance, and their approvals", async () => {
    const hub = fakeHub({ notes_get: "a note", notes_save: "saved", notes_peek: "peeked" });
    const model = createScriptedModel([
      { toolCalls: [{ name: "notes.peek", arguments: { id: "mine_1" } }] },
      { toolCalls: [{ name: "notes.save", arguments: { id: "theirs" } }] },
      { toolCalls: [{ name: "notes.save", arguments: { id: "mine_1" } }] },
      { toolCalls: [{ name: "final", arguments: { id: "mine_1" } }] },
    ]);
    const asked: string[] = [];
    const run = writer({ requires: ["notes.write"], optional: ["notes.read"] }).create({
      store,
      client: model,
      models: scriptedModelConfig(),
      runsDir: dir,
      consolidate: false,
      mcp: createMcpHost({ dir, hub }),
    });
    expect(
      run.tools.filter((t) => t.name.startsWith("notes.")).map((t) => [t.name, t.effect]),
    ).toEqual([
      ["notes.save", "write"],
      ["notes.get", "read"],
      ["notes.peek", "read"],
    ]);
    const result = await run({
      tenantId: "club-a",
      input: { topic: "t" },
      approver: async (req) => {
        asked.push(req.tool);
        return { approved: true, by: "editor" };
      },
    });
    expect(result.status).toBe("completed");
    const system = String(model.requests[0]?.messages[0]?.content);
    expect(system.startsWith("You write notes.")).toBe(true);
    expect(system).toContain("## Notes: what its MCP server says about its tools");
    expect(system).toContain("notes_save is notes.save");
    expect(system).toContain("Get a note before saving over it.");
    // a read the registry marks for approval is asked about; a write always is
    expect(asked).toEqual(["notes.peek", "notes.save"]);
    // the save outside the grant was refused before any person or server saw it
    expect(
      String(model.requests[2]?.messages.findLast((m) => m.role === "tool")?.content),
    ).toContain("id must match ^mine_");
    expect(hub.calls.map((c) => [c.tool, c.args.id, c.tenantId])).toEqual([
      ["notes_peek", "mine_1", "club-a"],
      ["notes_save", "mine_1", "club-a"],
    ]);
  });

  it("refuses to load an agent whose required capability no server has", () => {
    const agent = writer({ requires: ["weather"] });
    expect(() =>
      agent.create({
        store,
        client: createScriptedModel([]),
        models: scriptedModelConfig(),
        mcp: createMcpHost({ dir, hub: fakeHub({}) }),
      }),
    ).toThrow("no MCP server in config/mcp provides weather");
  });
});
