import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Situation, Tool, ToolContext } from "@dugout/contracts";
import { REPO_ROOT } from "@dugout/core";
import type { MemoryItem } from "@dugout/memory";
import { describe, expect, it } from "vitest";
import { spec } from "../src/agent.ts";
import { createBindTools, type Plane } from "../src/tools.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, "agents/data-bind/tests/fixtures", name), "utf8"));
const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000003";

const plane: Plane = {
  json: async () => fixture("news-grid.tree.json"),
  meta: async () => ({ irArtifactId: "ir-1" }),
  exportIr: async () => {
    throw new Error("no export");
  },
  // the frame's own IR names its layers; the whole document (the compiler's fixture, which has
  // layout) is what the section is signed from
  ir: async () => ({
    root: fixture("news-grid.ir.json").root,
    annotations: [],
    doc: JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/compile/fixtures/news-grid.ir.json"), "utf8"),
    ),
  }),
  dataset: async () => {
    throw new Error("no dataset");
  },
  upload: async (kind) => `${kind}-1`,
};

const decision = (over: Partial<MemoryItem>): MemoryItem => ({
  id: "d1",
  tenantId: "t",
  agentId: "hook-maker",
  kind: "episodic",
  key: "hook-maker:hook_choice@sig",
  episodeType: "decision",
  version: 1,
  content: 'On "Frame 1984078918", Sagar Chavan answered "Use the hook or build?": use_existing.',
  status: "active",
  confidence: 1,
  strength: 1,
  sourceRunId: "r",
  reviewedBy: null,
  createdAt: "2026-11-07T12:37:56.000Z",
  lastSeenAt: "2026-11-07T12:37:56.000Z",
  expiresAt: null,
  sharedScope: null,
  sources: [],
  value: "use_existing",
  ...over,
});

describe("bind.load and what a person decided before (ADR 0033)", () => {
  it("says which section the run works on, and lists what was decided about it", async () => {
    let situated: Situation | undefined;
    const asked: string[] = [];
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-decisions-")),
      plane: () => plane,
      decisions: {
        decisionsOn: async (_tenant, section) => {
          asked.push(section);
          return [decision({})];
        },
      },
    });
    const ctx: ToolContext = {
      tenantId: "t",
      runId: "run-d",
      signal: new AbortController().signal,
      input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
      situate: (s) => {
        situated = s;
      },
    };
    const load = tools.find((t) => t.name === "bind.load") as Tool;
    const out = (await load.run({}, ctx)) as { before?: string[]; beforeRule?: string };
    expect(situated?.section).toBe("s2:324766a5bec48384");
    expect(asked).toEqual([situated?.section]);
    expect(out.before).toEqual([
      expect.stringContaining("2026-11-07 hook-maker hook_choice: use_existing."),
    ]);
    expect(out.beforeRule).toMatch(/Keep to them/);
  });

  it("says how data_source was settled before, as its value, so code can end the run by it", async () => {
    const keys: string[] = [];
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-decisions-")),
      plane: () => plane,
      decisions: {
        decisionsOn: async () => [],
        decision: async (_tenant, key) => {
          keys.push(key);
          return decision({ key, value: "stand_in" });
        },
      },
    });
    const ctx: ToolContext = {
      tenantId: "t",
      runId: "run-settled",
      signal: new AbortController().signal,
      input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
    };
    const out = (await (tools.find((t) => t.name === "bind.load") as Tool).run({}, ctx)) as {
      settled?: { data_source?: string };
    };
    expect(keys).toEqual(["data-bind:data_source@s2:324766a5bec48384"]);
    expect(out.settled).toEqual({ data_source: "stand_in" });
  });

  it("names only declared questions in its skill", () => {
    const skill = readFileSync(join(REPO_ROOT, "agents/data-bind/skills/bind.md"), "utf8");
    const listed =
      /Give each question the id `ask` lists for it \(([^)]*)\)/.exec(skill)?.[1] ?? "";
    const ids = [...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.sort()).toEqual(Object.keys(spec.questions ?? {}).sort());
  });
});

describe("data_source: the feeds a person gives (ticket 02)", () => {
  it("is a question of the section, and the call to hook-maker shows the feeds", async () => {
    const { needLines } = await import("../src/agent.ts");
    expect(spec.questions?.data_source?.scope).toBe("section");
    const lines = needLines({
      list: "players",
      count: "data",
      item: [{ field: "name", required: true }],
      sources: [
        { label: "women", url: "https://x.test/squad?team_id=2034" },
        { label: "men", url: "https://x.test/squad?team_id=2042" },
      ],
    });
    expect(lines).toContain("Feeds given:");
    expect(lines).toContain("  women: https://x.test/squad?team_id=2034");
    expect(lines).toContain("  men: https://x.test/squad?team_id=2042");
  });

  it("says in the skill when to ask it and how the answer becomes need.sources", () => {
    const skill = readFileSync(join(REPO_ROOT, "agents/data-bind/skills/bind.md"), "utf8");
    expect(skill).toMatch(/open item `data_source`/);
    expect(skill).toMatch(/ask once before `bind\.source`, in your own words/);
    expect(skill).toMatch(/go to `agent\.hookMaker` as `need\.sources`/);
    // no fixed options: the model writes the question from the item
    expect(skill).not.toMatch(/stand_in/);
  });
});

describe("a club's feeds, known once (ticket 07)", () => {
  it("reads feed.<kind>.<label> facts as feeds, and nothing else", async () => {
    const { feedsOf } = await import("../src/feeds.ts");
    expect(
      feedsOf([
        { key: "feed.squad.women", content: "Women's squad: https://x.test/squad?team_id=1&a=b" },
        { key: "feed.squad.men", content: "Men's squad: https://x.test/squad?team_id=2" },
        { key: "feed.schedule", content: "no label: https://x.test/s" },
        { key: "feed.standings.women", content: "no URL here" },
        { key: "media.player-photo", content: "https://x.test/p/{id}.png" },
      ]),
    ).toEqual([
      { kind: "squad", label: "women", url: "https://x.test/squad?team_id=1&a=b" },
      { kind: "squad", label: "men", url: "https://x.test/squad?team_id=2" },
    ]);
  });

  it("lists them in bind.load, with the rule for using them", async () => {
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-feeds-")),
      plane: () => plane,
      decisions: {
        decisionsOn: async () => [],
        activeFacts: async () => [
          decision({ key: "feed.squad.men", content: "Men: https://x.test/squad?team_id=2" }),
        ],
      },
    });
    const ctx: ToolContext = {
      tenantId: "t",
      runId: "run-feeds",
      signal: new AbortController().signal,
      input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
    };
    const out = (await (tools.find((t) => t.name === "bind.load") as Tool).run({}, ctx)) as {
      feeds?: unknown[];
      feedsRule?: string;
    };
    expect(out.feeds).toEqual([
      { kind: "squad", label: "men", url: "https://x.test/squad?team_id=2" },
    ]);
    expect(out.feedsRule).toMatch(/need\.sources/);
  });
});

describe("who the club is, for the data to be about (ticket 09)", () => {
  it("reads club.team and club.competition from the house facts, and nothing when there are none", async () => {
    const { clubAbout } = await import("../src/feeds.ts");
    expect(
      clubAbout([
        { key: "club.team", content: " Southern Brave " },
        { key: "club.competition", content: "The Hundred" },
        { key: "style.tone", content: "x" },
      ]),
    ).toEqual({ team: "Southern Brave", competition: "The Hundred" });
    expect(clubAbout([{ key: "media.x", content: "y" }])).toEqual({});
  });
});

describe("the club's locale, for dates and times (ticket 10)", () => {
  it("reads the zone and date order from the house facts, and drops a zone that is not one", async () => {
    const { localeFacts } = await import("../src/feeds.ts");
    expect(
      localeFacts([
        { key: "locale.timezone", content: "Europe/London" },
        { key: "locale.date-order", content: "day-first" },
      ]),
    ).toEqual({ timeZone: "Europe/London", dateOrder: "dmy" });
    expect(localeFacts([{ key: "locale.date-order", content: "month-first" }])).toEqual({
      dateOrder: "mdy",
    });
    expect(localeFacts([{ key: "locale.timezone", content: "London time" }])).toEqual({});
    expect(localeFacts([])).toEqual({});
  });

  it("is in bind.load beside the rule that says how to use it", async () => {
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-locale-")),
      plane: () => plane,
      decisions: {
        decisionsOn: async () => [],
        activeFacts: async () => [decision({ key: "locale.timezone", content: "Asia/Kolkata" })],
      },
    });
    const ctx: ToolContext = {
      tenantId: "t",
      runId: "run-locale",
      signal: new AbortController().signal,
      input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
    };
    const out = (await (tools.find((t) => t.name === "bind.load") as Tool).run({}, ctx)) as {
      locale?: unknown;
      localeRule?: string;
    };
    expect(out.locale).toEqual({ timeZone: "Asia/Kolkata" });
    expect(out.localeRule).toMatch(/instant field/);
  });
});

describe("tools report what is open, the model asks (ticket 11)", () => {
  it("bind.load reports the data source as an open item with evidence, candidates and what it takes", async () => {
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-open-")),
      plane: () => plane,
      decisions: {
        decisionsOn: async () => [],
        activeFacts: async () => [
          decision({ key: "feed.squad.men", content: "Men: https://x.test/squad?team_id=2" }),
        ],
      },
    });
    const ctx: ToolContext = {
      tenantId: "t",
      runId: "run-open",
      signal: new AbortController().signal,
      input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
    };
    const out = (await (tools.find((t) => t.name === "bind.load") as Tool).run({}, ctx)) as {
      open?: Array<{
        id: string;
        evidence: string;
        candidates: Array<{ value: string }>;
        canTake: string;
      }>;
      openRule?: string;
    };
    expect(out.open).toHaveLength(1);
    expect(out.open?.[0]).toMatchObject({ id: "data_source" });
    expect(out.open?.[0]?.evidence).toContain("squad.men https://x.test/squad?team_id=2");
    expect(out.open?.[0]?.candidates.map((c) => c.value)).toEqual([
      "find_hook",
      "stand_in",
      "none",
    ]);
    // what the next call takes beyond the candidates: the endpoint a person gives
    expect(out.open?.[0]?.canTake).toMatch(/feed URLs.*need\.sources/);
    expect(out.openRule).toMatch(/ask a person with `ask`/);
    // no question text is written in the tool: the item is data
    expect(JSON.stringify(out.open)).not.toMatch(/\?(["\s]|$)/);
  });
});
