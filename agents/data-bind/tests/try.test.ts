import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { createMcpHost } from "@dugout/mcp";
import { fakeHub } from "@dugout/mcp/testing";
import { describe, expect, it } from "vitest";
import { createBindTools, type Plane } from "../src/tools.ts";

/**
 * bind.try through the tool, on a hook's live output (tickets 09, 15): the checks read the data
 * by the names the plan reads it by, as a real run gives it.
 */
const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000015";
const node = (
  id: string,
  parent: string | null,
  type: string,
  idx: number,
  props: object = {},
) => ({
  id,
  idx,
  parent,
  src: id,
  type,
  props,
});
/** A heading over two cards, each a title and a date. */
const frame = (heading: string) => ({
  schemaVersion: "1",
  nodes: [
    node("root", null, "Stack", 0),
    node("h", "root", "Text", 0, { content: heading }),
    node("list", "root", "Stack", 1),
    node("c1", "list", "Stack", 0),
    node("c1-t", "c1", "Text", 0, { content: "Headline" }),
    node("c1-d", "c1", "Text", 1, { content: "21 Jul 2026" }),
    node("c2", "list", "Stack", 1),
    node("c2-t", "c2", "Text", 0, { content: "Headline" }),
    node("c2-d", "c2", "Text", 1, { content: "21 Jul 2026" }),
  ],
});

const planeFor = (tree: unknown): Plane => ({
  json: async () => tree,
  meta: async () => ({}),
  exportIr: async () => {
    throw new Error("no export");
  },
  ir: async () => {
    throw new Error("no IR");
  },
  dataset: async () => {
    throw new Error("no dataset");
  },
  upload: async (kind) => `${kind}-1`,
});

/** A Cast hook whose live output is `output`. */
const hookGiving = (output: unknown) =>
  createMcpHost({
    hub: fakeHub({
      cast_describe_hook: (args) => ({
        text: "STEPS",
        structured: {
          id: args.hookId,
          name: "Feed",
          status: "published",
          readOnly: true,
          callsHooks: false,
        },
        isError: false,
      }),
      cast_run_hook: () => ({
        text: "RUN",
        structured: {
          runId: "r1",
          hookId: "h",
          status: "ok",
          durationMs: 1,
          steps: [],
          outputComputed: true,
          output,
          budget: { remaining: 24, used: 1 },
        },
        isError: false,
      }),
    }),
  });

const ctx = (runId: string): ToolContext => ({
  tenantId: `try-${runId}`,
  runId,
  signal: new AbortController().signal,
  state: memoryRunState(),
  input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
});
const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name) as Tool;
const problemsOf = (out: unknown) => [(out as { problems: string[] | string }).problems].flat();

describe("bind.try on a hook's live output", () => {
  it("reports how the articles' dates run, and leaves the order to the binder", async () => {
    const articles = (dates: string[]) => ({
      items: dates.map((published, i) => ({ title: `Story ${i}`, published })),
    });
    const plan = JSON.stringify({
      collapse: [
        {
          over: "news.items",
          as: "n",
          members: ["c1", "c2"],
          fields: [
            { src: "c1-t", prop: "content", path: "title" },
            { src: "c1-d", prop: "content", path: 'published | date:"DD MMM YYYY"' },
          ],
        },
      ],
    });
    const run = async (dates: string[], id: string) => {
      const tools = createBindTools({
        dir: await mkdtemp(join(tmpdir(), "bind-try-")),
        plane: () => planeFor(frame("LATEST NEWS")),
        mcp: hookGiving(articles(dates)),
      });
      await tool(tools, "bind.source").run({ hookId: "dugout_news", as: "news" }, ctx(id));
      return (await tool(tools, "bind.try").run({ plan }, ctx(id))) as {
        problems: string[] | string;
        order?: string[];
        orderRule?: string;
      };
    };
    const oldest = await run(["2026-06-01T10:00:00Z", "2026-07-01T10:00:00Z"], "order-up");
    expect(oldest.order).toEqual([
      "news.items by published: 2026-06-01T10:00:00Z, 2026-07-01T10:00:00Z (earliest first; 2 of 2 before now)",
    ]);
    expect(oldest.orderRule).toMatch(/yours to read from the design/);
    // an order is never a problem code raises: the binder compares it with the design
    expect(problemsOf(oldest).join("\n")).not.toMatch(/first|order/);
    const latest = await run(["2026-07-01T10:00:00Z", "2026-06-01T10:00:00Z"], "order-down");
    expect(latest.order?.[0]).toContain("(latest first;");
  });

  it("says what the data's items name beside what the design is about, and raises nothing on it", async () => {
    const fixtures = {
      items: [
        { title: "Riverside v Hill Town", kickoff: "2026-07-21T19:00:00Z", home_team: "Riverside" },
        { title: "Hill Town v Lakeside", kickoff: "2026-07-28T19:00:00Z", home_team: "Hill Town" },
      ],
    };
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-try-")),
      plane: () => planeFor(frame("FIXTURES")),
      mcp: hookGiving(fixtures),
    });
    const c = ctx("entity");
    const read = (await tool(tools, "bind.source").run(
      { hookId: "dugout_fixtures", as: "fixtures", about: { team: "Western Stars" } },
      c,
    )) as { about: { team?: string; dataNames: string[] | string }; aboutRule: string };
    expect(read.about.team).toBe("Western Stars");
    expect(read.about.dataNames).toEqual([
      'fixtures.items: its 2 item(s) name the team "Riverside", "Hill Town" in home_team',
    ]);
    expect(read.aboutRule).toMatch(/Code does not judge them/);
    const collapse = {
      over: "fixtures.items",
      as: "m",
      members: ["c1", "c2"],
      fields: [
        { src: "c1-t", prop: "content", path: "title" },
        { src: "c1-d", prop: "content", path: 'kickoff | date:"DD MMM YYYY"' },
      ],
    };
    const tried = problemsOf(
      await tool(tools, "bind.try").run({ plan: JSON.stringify({ collapse: [collapse] }) }, c),
    );
    expect(tried.join("\n")).not.toContain("Western Stars");
    const done = (await tool(tools, "bind.publish").run(
      { despite: "a test publish" },
      c,
    )) as Record<string, unknown>;
    // the ending is the model's to say in final: the tool records no reading of its own
    expect(done.standIn).toBeUndefined();
    expect(done.readings).toBeUndefined();
  });
});
