import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { createBindTools, type Plane } from "../src/tools.ts";

const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000009";

interface N {
  id: string;
  idx: number;
  parent: string | null;
  src: string;
  type: string;
  props: Record<string, unknown>;
}
const node = (
  id: string,
  parent: string | null,
  type: string,
  props: N["props"] = {},
  idx = 0,
): N => ({
  id,
  idx,
  parent,
  src: id,
  type,
  props,
});
const text = (id: string, parent: string, content: string, idx = 0) =>
  node(id, parent, "Text", { content }, idx);

/** One frame, two slots: a fixtures strip, and a squad with WOMEN | MEN tabs over its cards. */
function frame() {
  const nodes: N[] = [node("root", null, "Stack")];
  // fixtures slot
  nodes.push(node("fx", "root", "Stack", {}, 0), text("fx-h", "fx", "THE ROAD AHEAD"));
  for (const i of [1, 2, 3]) {
    nodes.push(
      node(`fc${i}`, "fx", "Stack", {}, i),
      text(`fc${i}-v`, `fc${i}`, "Women v Men", 0),
      text(`fc${i}-t`, `fc${i}`, "21 JULY", 1),
    );
  }
  // squad slot: tabs, then the cards
  nodes.push(node("sq", "root", "Stack", {}, 1), text("sq-h", "sq", "THE BRAVE SQUAD"));
  nodes.push(
    node("tab-w", "sq", "Stack", { select: { key: "squad_women_men", value: "women" } }, 1),
    text("tab-w-t", "tab-w", "WOMEN"),
    node("tab-m", "sq", "Stack", { select: { key: "squad_women_men", value: "men" } }, 2),
    text("tab-m-t", "tab-m", "MEN"),
  );
  for (const i of [1, 2, 3]) {
    nodes.push(
      node(`sc${i}`, "sq", "Stack", {}, 2 + i),
      text(`sc${i}-n`, `sc${i}`, "Player Name", 0),
      text(`sc${i}-t`, `sc${i}`, "Southern Brave", 1),
    );
  }
  const owned = (prefix: string[]) => nodes.filter((n) => prefix.some((p) => n.id.startsWith(p)));
  return {
    tree: { schemaVersion: "1", nodes },
    fixtures: { id: "fx", name: "the-road-ahead", nodes: owned(["fx", "fc"]).map((n) => n.id) },
    squad: {
      id: "sq",
      name: "the-brave-squad",
      nodes: owned(["sq", "tab", "sc"]).map((n) => n.id),
    },
  };
}

const data = {
  fixtures: {
    items: [1, 2, 3].map((i) => ({ title: `Match ${i}`, team: i === 1 ? "Women" : "Men" })),
  },
  squad: {
    items: [
      { name: "Sophie", team: "Women" },
      { name: "Alex", team: "Men" },
      { name: "Chris", team: "Men" },
    ],
  },
};

const setup = () => {
  const f = frame();
  const uploads: Array<{ kind: string; json: unknown; meta: Record<string, unknown> }> = [];
  const plane: Plane = {
    json: async () => f.tree,
    // what frame-match published: the squad draws the tabs
    meta: async () => ({
      choices: [
        {
          key: "squad_women_men",
          options: [{ value: "women" }, { value: "men" }],
          initial: "men",
          owner: "sq",
        },
      ],
    }),
    exportIr: async () => {
      throw new Error("no export");
    },
    ir: async () => {
      throw new Error("no IR artifact");
    },
    dataset: async () => data,
    upload: async (kind, json, meta) => {
      uploads.push({ kind, json, meta });
      return `${kind}-${uploads.length}`;
    },
  };
  return { f, plane, uploads };
};

const ctx = (runId: string, slot: unknown): ToolContext => ({
  tenantId: `slot-${runId}`,
  runId,
  signal: new AbortController().signal,
  state: memoryRunState(),
  input: { preview: `http://localhost:3000/preview/default/${TREE_ID}`, data: "ds", slot },
});
const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name) as Tool;

const squadPlan = {
  note: "squad",
  collapse: [
    {
      over: "squad.items",
      as: "p",
      members: ["sc1", "sc2", "sc3"],
      when: { path: "p.team", eqPath: "_page.squad_women_men" },
      fields: [
        { src: "sc1-n", prop: "content", path: "name" },
        { src: "sc1-t", prop: "content", path: "team" },
      ],
    },
  ],
  keep: [
    { src: "sq-h", why: "the squad's own heading" },
    { src: "tab-w", why: "the tabs are the squad's choice" },
    { src: "tab-m", why: "the tabs are the squad's choice" },
  ],
};

describe("bind for one slot", () => {
  it("shows the squad its own nodes and the choice it draws, linked to its cards, and none of the fixtures", async () => {
    const { f, plane } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bind-slot-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const run = ctx("squad", { ...f.squad, readFrom: [] });
    const loaded = (await tool(tools, "bind.load").run({}, run)) as {
      frame: string;
      repeats: string;
      writes: string[];
      links: string[];
      slot: { name: string; words: string[] };
    };
    expect(loaded.frame).toContain("sc1 Stack");
    expect(loaded.frame).not.toContain("fc1");
    expect(loaded.repeats).toContain("sc1");
    expect(loaded.repeats).not.toContain("fc1");
    expect(loaded.slot.name).toBe("the-brave-squad");
    expect(loaded.slot.words).toContain("THE BRAVE SQUAD");
    expect(loaded.writes).toEqual([expect.stringContaining("_page.squad_women_men")]);
    // (this dataset holds both lists; a slot run's own data holds only its own)
    expect(loaded.links).toContainEqual(expect.stringContaining("squad.items"));
  });

  it("refuses to read a node of another slot", async () => {
    const { f, plane } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bind-slot-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const run = ctx("node", { ...f.squad, readFrom: [] });
    await expect(tool(tools, "bind.node").run({ src: "fc1" }, run)).rejects.toThrow(
      /outside the slot the-brave-squad/,
    );
    await expect(tool(tools, "bind.node").run({ src: "sc1" }, run)).resolves.toBeDefined();
  });

  it("binds the squad's plan, reports no problems about the fixtures, and ends with bind.done", async () => {
    const { f, plane, uploads } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bind-slot-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const run = ctx("squad-plan", { ...f.squad, readFrom: [] });
    const tried = (await tool(tools, "bind.try").run({ plan: JSON.stringify(squadPlan) }, run)) as {
      problems: string[] | string;
      bound: number;
    };
    expect(tried.bound).toBeGreaterThan(0);
    const problems = tried.problems === "none" ? [] : (tried.problems as string[]);
    // nothing is said of the fixtures' cards, though they hold the design's copy
    expect(problems.filter((p) => /fc\d|fx/.test(p))).toEqual([]);
    expect(problems.filter((p) => /outside the slot|does not draw/.test(p))).toEqual([]);

    // bind.publish is not this run's end; bind.done is, and it leaves the preview as it was
    expect(await tool(tools, "bind.publish").block?.({}, { ...run, input: run.input })).toMatch(
      /call bind.done/,
    );
    const done = (await tool(tools, "bind.done").run({}, run)) as {
      previewUrl: string;
      planArtifactId: string;
      dataArtifactId: string;
    };
    expect(done.previewUrl).not.toContain("plan=");
    expect(uploads.map((u) => u.kind)).toEqual(["sample_data", "binding_plan"]);
    expect(uploads[1]?.meta).toMatchObject({ slot: { id: "sq", name: "the-brave-squad" } });
  });

  it("reports a plan that names a node outside the slot", async () => {
    const { f, plane } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bind-slot-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const run = ctx("squad-out", { ...f.squad, readFrom: [] });
    const plan = { bind: [{ src: "fc1-v", prop: "content", path: "squad.items.0.name" }] };
    const tried = (await tool(tools, "bind.try").run({ plan: JSON.stringify(plan) }, run)) as {
      problems: string[];
    };
    expect(tried.problems.join("\n")).toMatch(/fc1-v, which is outside the slot the-brave-squad/);
  });

  it("gives the fixtures no choice and no link, though its items hold Women and Men", async () => {
    const { f, plane } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bind-slot-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const run = ctx("fixtures", { ...f.fixtures, readFrom: [] });
    const loaded = (await tool(tools, "bind.load").run({}, run)) as Record<string, unknown>;
    expect(loaded.writes).toBeUndefined();
    expect(loaded.pageChoices).toBeUndefined();
    expect(loaded.links).toBeUndefined();
    expect(String(loaded.frame)).not.toContain("sc1");
  });

  it("reports a fixtures plan that follows the squad's tabs", async () => {
    const { f, plane } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bind-slot-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const plan = {
      collapse: [
        {
          over: "fixtures.items",
          as: "m",
          members: ["fc1", "fc2", "fc3"],
          when: { path: "m.team", eqPath: "_page.squad_women_men" },
          fields: [{ src: "fc1-v", prop: "content", path: "title" }],
        },
      ],
    };
    const tried = (await tool(tools, "bind.try").run(
      { plan: JSON.stringify(plan) },
      ctx("fixtures-follows", { ...f.fixtures, readFrom: [] }),
    )) as { problems: string[]; publishable: boolean };
    expect(tried.publishable).toBe(false);
    expect(tried.problems.join("\n")).toMatch(
      /reads _page.squad_women_men, a choice slot the-road-ahead does not draw/,
    );
    // told to read it on purpose, the same plan is not faulted for it
    const allowed = (await tool(tools, "bind.try").run(
      { plan: JSON.stringify(plan) },
      ctx("fixtures-allowed", { ...f.fixtures, readFrom: ["squad_women_men"] }),
    )) as { problems: string[] | string };
    expect([allowed.problems].flat().join("\n")).not.toMatch(/does not draw/);
  });

  it("names the data for the slot when bind.source is not given a name", async () => {
    const { camel } = await import("../src/tools.ts");
    expect(camel("the-brave-squad")).toBe("theBraveSquad");
    expect(camel("2024-squad")).toBe("s2024Squad");
  });
});
