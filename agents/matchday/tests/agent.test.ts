import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@dugout/contracts";
import { createMemorySink, createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { seedHouseFacts } from "@dugout/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { agent, type Channel, type Pack } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
beforeAll(() => seedHouseFacts(store, ["demo-cricket", "demo-football"]));

const lastTool = (req: ModelRequest) => JSON.parse(req.messages.at(-1)?.content ?? "{}");

interface LoadedFixture {
  fixtureId: string;
  home: string;
  away: string;
  venue: string;
  date: string;
  kickoffLocal: string;
  homeTeam: { name: string };
  awayTeam: { name: string };
}

// the run input follows the recalled memory in the first user message
const inputOf = (req: ModelRequest) =>
  JSON.parse(
    (req.messages.find((message) => message.role === "user")?.content ?? "{}").replace(
      /^<recalled_memory>[\s\S]*<\/recalled_memory>\n\n/,
      "",
    ),
  ) as {
    fixtureId: string;
    channels?: Channel[];
  };

/** Follows the workflow. `channels` must match the run input, so the script loads those skills. */
function writerScript(channels: Channel[] = []) {
  let fixture: LoadedFixture;
  const steps = [
    (req: ModelRequest) => ({
      toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: inputOf(req).fixtureId } }],
    }),
    (req: ModelRequest) => {
      fixture = lastTool(req);
      return {
        toolCalls: [
          { name: "team.stats", arguments: { teamId: fixture.home } },
          { name: "team.stats", arguments: { teamId: fixture.away } },
        ],
      };
    },
    ...(channels.length
      ? [
          () => ({
            toolCalls: channels.map((name) => ({ name: "skill.load", arguments: { name } })),
          }),
        ]
      : []),
    () => ({ toolCalls: [{ name: "pack.save", arguments: packFor(fixture, channels) }] }),
    () => ({ toolCalls: [{ name: "final", arguments: packFor(fixture, channels) }] }),
  ];
  return steps;
}

function packFor(fixture: LoadedFixture, channels: Channel[]): Pack {
  const { homeTeam, awayTeam } = fixture;
  return {
    fixtureId: fixture.fixtureId,
    channels,
    preview: {
      title: `${homeTeam.name} v ${awayTeam.name}`,
      body: `${homeTeam.name} host ${awayTeam.name} at ${fixture.venue} on ${fixture.date}, starting at ${fixture.kickoffLocal}.`,
    },
    social: channels.includes("social")
      ? `${homeTeam.name} face ${awayTeam.name} at ${fixture.venue}.`
      : null,
    push: channels.includes("push")
      ? `${homeTeam.name} v ${awayTeam.name}, ${fixture.kickoffLocal}.`
      : null,
    headline: channels.includes("headline") ? `${homeTeam.name} host ${awayTeam.name}` : null,
  };
}

let packsDir: string;
let runsDir: string;
beforeEach(async () => {
  packsDir = await mkdtemp(join(tmpdir(), "packs-"));
  runsDir = await mkdtemp(join(tmpdir(), "runs-"));
});

const build = (script: Parameters<typeof createScriptedModel>[0]) => {
  const client = createScriptedModel(script);
  const run = agent.create({
    store,
    client,
    models: scriptedModelConfig(),
    packsDir,
    runsDir,
    consolidate: false,
  });
  return { run, client };
};

const approve = async () => ({ approved: true as const, by: "editor" });

describe("matchday agent", () => {
  it("saves a pack for each tenant from its own data, after approval", async () => {
    for (const [tenantId, fixtureId, title] of [
      ["demo-cricket", "c-101", "Mumbai Mariners v Chennai Chargers"],
      ["demo-football", "f-201", "Austin Armadillos v Boston Beacons"],
    ] as const) {
      const { run } = build(writerScript());
      const result = await run({
        tenantId,
        input: { fixtureId },
        approver: approve,
      });
      expect(result.status).toBe("completed");
      const saved = JSON.parse(
        await readFile(join(packsDir, tenantId, `${fixtureId}.json`), "utf8"),
      );
      expect(saved).toMatchObject({ fixtureId, preview: { title }, channels: [] });
    }
  });

  it("loads the skill, lists the channel skills, and keeps the other tenant's facts out", async () => {
    const { run, client } = build(writerScript(["social"]));
    await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101", channels: ["social"] },
      approver: approve,
    });
    const system = client.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("## Skill: matchday");
    expect(system).toContain("## Skills you can load");
    expect(system).toContain("social:");
    expect(system).toContain("British English");
    expect(system).not.toContain("US soccer fans");
    expect(system).not.toContain("At most 280 characters");
    const loaded = client.requests.at(-2)?.messages.at(-1)?.content ?? "";
    expect(loaded).toContain("## Skill: social");
    expect(loaded).toContain("280 characters");
  });

  it("does not load a channel skill when the input asks for none", async () => {
    const { run } = build(writerScript());
    const sink = createMemorySink();
    await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101" },
      approver: approve,
      sinks: [sink],
    });
    expect(
      sink.events.some(
        (event) => event.type === "tool.started" && event.data.tool === "skill.load",
      ),
    ).toBe(false);
  });

  it("denies a pack with betting language before asking for approval", async () => {
    const badBody = "Place a bet on the Mumbai Mariners at Wankhede Arena tonight with the crowd.";
    const good: Pack = {
      fixtureId: "c-101",
      channels: [],
      preview: {
        title: "Mumbai Mariners v Chennai Chargers",
        body: "Mumbai Mariners host Chennai Chargers at Wankhede Arena on 2026-11-02, starting at 19:30.",
      },
      social: null,
      push: null,
      headline: null,
    };
    const { run, client } = build([
      () => ({ toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: "c-101" } }] }),
      () => ({
        toolCalls: [
          { name: "team.stats", arguments: { teamId: "mum" } },
          { name: "team.stats", arguments: { teamId: "che" } },
        ],
      }),
      () => ({
        toolCalls: [
          {
            name: "pack.save",
            arguments: { ...good, preview: { ...good.preview, body: badBody } },
          },
        ],
      }),
      () => ({ toolCalls: [{ name: "pack.save", arguments: good }] }),
      () => ({ toolCalls: [{ name: "final", arguments: good }] }),
    ]);
    const sink = createMemorySink();
    const result = await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101", brief: "betting language" },
      approver: approve,
      sinks: [sink],
    });
    expect(client.requests[3]?.messages.at(-1)?.content).toContain(
      "betting language is not allowed",
    );
    expect(sink.events.filter((event) => event.type === "approval.requested")).toHaveLength(1);
    expect(result).toMatchObject({ status: "completed", output: good });
  });

  it("does not accept a final pack that uses betting language", async () => {
    const good: Pack = {
      fixtureId: "c-101",
      channels: [],
      preview: {
        title: "Mumbai Mariners v Chennai Chargers",
        body: "Mumbai Mariners host Chennai Chargers at Wankhede Arena on 2026-11-02, starting at 19:30.",
      },
      social: null,
      push: null,
      headline: null,
    };
    const bad = {
      ...good,
      preview: { ...good.preview, title: "Odds on Mumbai Mariners" },
    };
    const { run, client } = build([
      () => ({ toolCalls: [{ name: "final", arguments: bad }] }),
      () => ({ toolCalls: [{ name: "final", arguments: good }] }),
    ]);
    const result = await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101" },
      approver: approve,
    });
    expect(client.requests[1]?.messages.at(-1)?.content).toContain("Invalid result");
    expect(result).toMatchObject({ status: "completed", output: good });
  });

  it("reads a lesson about the brief and leaves an unrelated one out", async () => {
    const sourceRunId = randomUUID();
    const betting = "Never use betting language in the preview";
    const unrelated = "Include only static pages in the sitemap";
    const sourceIds = new Set<string>();
    for (const content of [betting, unrelated]) {
      const item = await store.addEpisode({
        tenantId: "demo-cricket",
        agentId: "sitemap",
        episodeType: "lesson",
        content,
        confidence: 0.9,
        sourceRunId,
        ttlDays: 30,
      });
      if (item.sourceRunId) sourceIds.add(item.sourceRunId);
    }
    try {
      const { run, client } = build(writerScript());
      const sink = createMemorySink();
      await run({
        tenantId: "demo-cricket",
        input: { fixtureId: "c-101", brief: "betting language" },
        approver: approve,
        sinks: [sink],
      });
      // lessons are recalled memory: in the first user message, not the system prompt
      expect(client.requests[0]?.messages[0]?.content).not.toContain(betting);
      const recalled = client.requests[0]?.messages[1]?.content ?? "";
      expect(recalled).toContain(betting);
      expect(recalled).not.toContain("static pages");
      const built = sink.events.find((event) => event.type === "context.built");
      const episodic =
        built?.type === "context.built"
          ? built.data.sources.filter((source) => source.kind === "episodic")
          : [];
      expect(episodic.map((source) => source.text).join("\n")).toContain(betting);
      expect(episodic.map((source) => source.text).join("\n")).not.toContain("static pages");
    } finally {
      for (const id of sourceIds) await store.deleteBySourceRun("demo-cricket", id);
    }
  });

  it("cannot read another tenant's fixtures", async () => {
    const { run, client } = build([
      () => ({ toolCalls: [{ name: "fixtures.get", arguments: { fixtureId: "f-201" } }] }),
      () => ({ toolCalls: [{ name: "final", arguments: packFor(cricketFixture(), []) }] }),
    ]);
    await run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-101" },
      approver: approve,
    });
    expect(client.requests[1]?.messages.at(-1)?.content).toBe("Error: no fixture f-201");
  });

  it("saving the same pack twice changes nothing", async () => {
    const first = build(writerScript());
    await first.run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-102" },
      approver: approve,
    });
    const file = join(packsDir, "demo-cricket", "c-102.json");
    const before = (await stat(file)).mtimeMs;
    const second = build(writerScript());
    const sink = createMemorySink();
    await second.run({
      tenantId: "demo-cricket",
      input: { fixtureId: "c-102" },
      approver: approve,
      sinks: [sink],
    });
    expect((await stat(file)).mtimeMs).toBe(before);
    const save = sink.events.find(
      (event) => event.type === "tool.completed" && event.data.tool === "pack.save",
    );
    expect(save?.type === "tool.completed" && save.data.content).toContain('"unchanged":true');
  });

  it("rejects a fixture id that is not one of ours", () => {
    const { run } = build(writerScript());
    expect(() =>
      run({ tenantId: "demo-cricket", input: { fixtureId: "101" }, approver: approve }),
    ).toThrow();
  });
});

/** Enough of c-101 for a final call that never reads the tool. */
function cricketFixture(): LoadedFixture {
  return {
    fixtureId: "c-101",
    home: "mum",
    away: "che",
    venue: "Wankhede Arena",
    date: "2026-11-02",
    kickoffLocal: "19:30",
    homeTeam: { name: "Mumbai Mariners" },
    awayTeam: { name: "Chennai Chargers" },
  };
}
