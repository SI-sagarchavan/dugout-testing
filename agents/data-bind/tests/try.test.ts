import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@dugout/contracts";
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
  input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
});
const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name) as Tool;
const problemsOf = (out: unknown) => [(out as { problems: string[] | string }).problems].flat();

describe("bind.try on a hook's live output", () => {
  it("faults articles sent oldest first where the design means the latest, and passes them sorted", async () => {
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
      await tool(tools, "bind.source").run(
        { hookId: "dugout_news", as: "news", order: "newest-first" },
        ctx(id),
      );
      return problemsOf(await tool(tools, "bind.try").run({ plan }, ctx(id)));
    };
    const wrong = await run(["2026-06-01T10:00:00Z", "2026-07-01T10:00:00Z"], "order-wrong");
    expect(wrong.join("\n")).toContain("news.items is not newest first");
    const sorted = await run(["2026-07-01T10:00:00Z", "2026-06-01T10:00:00Z"], "order-ok");
    expect(sorted.join("\n")).not.toContain("newest first");
  });

  it("faults fixtures about other clubs, and takes a keep with why: advice, so it can end bound", async () => {
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
    )) as { about: { reading: string } };
    expect(read.about.reading).toBe("other");
    const collapse = {
      over: "fixtures.items",
      as: "m",
      members: ["c1", "c2"],
      fields: [
        { src: "c1-t", prop: "content", path: "title" },
        { src: "c1-d", prop: "content", path: 'kickoff | date:"DD MMM YYYY"' },
      ],
    };
    const open = problemsOf(
      await tool(tools, "bind.try").run({ plan: JSON.stringify({ collapse: [collapse] }) }, c),
    );
    expect(open.join("\n")).toContain("the design is about Western Stars");
    const kept = (await tool(tools, "bind.try").run(
      {
        plan: JSON.stringify({
          collapse: [collapse],
          keep: [{ src: "c1", why: "the feed writes the club by its old name" }],
        }),
      },
      c,
    )) as { problems: string[] | string; kept?: string[] };
    expect(problemsOf(kept).join("\n")).not.toContain("Western Stars");
    expect(kept.kept?.join("\n")).toContain("Western Stars");
    const done = (await tool(tools, "bind.publish").run({ despite: "a test publish" }, c)) as {
      standIn?: string;
      readings: Array<{ reading: string; kept?: boolean }>;
    };
    expect(done.standIn).toBeUndefined();
    expect(done.readings).toEqual([expect.objectContaining({ reading: "other", kept: true })]);
  });
});
