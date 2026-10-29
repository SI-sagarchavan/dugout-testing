import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@dugout/contracts";
import {
  createMemorySink,
  createScriptedModel,
  type ScriptedTurn,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createMatchPreview, seedHouseStyle, spec } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
beforeAll(() => seedHouseStyle(store, ["demo-cricket", "demo-football"]));

const lastTool = (req: ModelRequest) => JSON.parse(req.messages.at(-1)?.content ?? "{}");

/** Follows the agent's workflow using whatever the tools return. */
function writerScript(
  fixtureId: string,
  body = "A measured preview of both sides and their recent form.",
): Array<(req: ModelRequest) => ScriptedTurn> {
  let fixture: {
    home: string;
    away: string;
    homeTeam: { name: string };
    awayTeam: { name: string };
  };
  return [
    () => ({ toolCalls: [{ name: "fixtures.get", arguments: { fixtureId } }] }),
    (req) => {
      fixture = lastTool(req);
      return {
        toolCalls: [
          { name: "team.stats", arguments: { teamId: fixture.home } },
          { name: "team.stats", arguments: { teamId: fixture.away } },
        ],
      };
    },
    () => ({
      toolCalls: [
        {
          name: "draft.save",
          arguments: {
            fixtureId,
            title: `${fixture.homeTeam.name} v ${fixture.awayTeam.name}`,
            body,
          },
        },
      ],
    }),
    () => ({ content: "Saved the draft." }),
  ];
}

let draftsDir: string;
let runsDir: string;
let tenantSuffix: string;
beforeEach(async () => {
  draftsDir = await mkdtemp(join(tmpdir(), "drafts-"));
  runsDir = await mkdtemp(join(tmpdir(), "runs-"));
  tenantSuffix = randomUUID().slice(0, 6);
});

const preview = (
  script: Parameters<typeof createScriptedModel>[0],
  lessons?: () => Promise<string>,
) => {
  const client = createScriptedModel(script);
  const run = createMatchPreview({
    store,
    client,
    models: scriptedModelConfig(),
    draftsDir,
    runsDir,
    // only the memory test writes memory; anything else would pile up in the shared test database
    consolidate: lessons !== undefined,
    ...(lessons ? { lessons } : {}),
  });
  return { run, client };
};

describe("match-preview", () => {
  it("writes a draft for each tenant from its own data, after approval", async () => {
    for (const [tenantId, fixtureId, title] of [
      ["demo-cricket", "c-101", "Mumbai Mariners v Chennai Chargers"],
      ["demo-football", "f-201", "Austin Armadillos v Boston Beacons"],
    ] as const) {
      const { run } = preview(writerScript(fixtureId));
      const result = await run({
        tenantId,
        input: { fixtureId },
        approver: async () => ({ approved: true, by: "editor" }),
      });
      expect(result.status).toBe("completed");
      const saved = JSON.parse(
        await readFile(join(draftsDir, tenantId, `${fixtureId}.json`), "utf8"),
      );
      expect(saved).toMatchObject({ fixtureId, title });
    }
  });

  it("loads the skill, tenant override and house facts into the instructions", async () => {
    const { run, client } = preview(writerScript("c-101"));
    const sink = createMemorySink();
    await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101" },
      approver: async () => ({ approved: false, by: "editor", reason: "test" }),
      sinks: [sink],
    });
    const system = client.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("## Skill: match-preview");
    expect(system).toContain("Mention the format (T20)");
    expect(system).toContain("British English");
    expect(system).not.toContain("US English");
    expect(sink.events.find((e) => e.type === "context.built")).toBeDefined();
  });

  it("cannot read another tenant's fixtures", async () => {
    const { run, client } = preview([
      () => ({ toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: "f-201" } }] }),
      () => ({ content: "Could not find it." }),
    ]);
    await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "f-201" },
      approver: async () => ({ approved: true, by: "x" }),
    });
    expect(client.requests[1]?.messages.at(-1)?.content).toBe("Error: no fixture f-201");
  });

  it("compacts the long stats output into a reference", async () => {
    const { run, client } = preview(writerScript("c-101"));
    await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101" },
      approver: async () => ({ approved: true, by: "x" }),
    });
    const stats = lastTool(client.requests[2] as ModelRequest);
    expect(stats.ref).toMatch(/^out-\d+$/);
    expect(stats.preview).toContain('"name":"Chennai Chargers"');
  });

  it("saving the same draft twice changes nothing", async () => {
    for (let i = 0; i < 2; i++) {
      const { run, client } = preview(writerScript("c-102"));
      await run({
        tenantId: "demo-cricket",
        input: { fixtureId: "c-102" },
        approver: async () => ({ approved: true, by: "x" }),
      });
      expect(JSON.parse(client.requests[3]?.messages.at(-1)?.content ?? "{}").unchanged).toBe(
        i === 1,
      );
    }
  });

  it("remembers a rejection as a lesson in that tenant's next run only", async () => {
    const tenantId = "demo-cricket";
    const reason = `Don't call the match a clash ${tenantSuffix}`;
    const first = preview(
      writerScript("c-103", "An epic clash awaits."),
      async () => `Never call a match a clash ${tenantSuffix}.`,
    );
    const rejected = await first.run({
      tenantId,
      input: { fixtureId: "c-103" },
      approver: async () => ({ approved: false, by: "editor", reason }),
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.afterRunError).toBeUndefined();

    const second = preview(writerScript("c-103"));
    await second.run({
      tenantId,
      input: { fixtureId: "c-103" },
      approver: async () => ({ approved: true, by: "x" }),
    });
    expect(second.client.requests[0]?.messages[0]?.content).toContain(
      `Never call a match a clash ${tenantSuffix}.`,
    );

    const other = preview(writerScript("f-203"));
    await other.run({
      tenantId: "demo-football",
      input: { fixtureId: "f-203" },
      approver: async () => ({ approved: true, by: "x" }),
    });
    expect(other.client.requests[0]?.messages[0]?.content).not.toContain(tenantSuffix);

    await store.deleteBySourceRun(tenantId, rejected.runId);
  });

  it("declares every tool it uses", () => {
    expect(spec.tools).toEqual([
      "fixtures.get",
      "team.stats",
      "draft.save",
      "memory.search",
      "memory.propose",
    ]);
  });
});
