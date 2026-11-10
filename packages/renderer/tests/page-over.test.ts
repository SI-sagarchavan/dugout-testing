import { afterAll, describe, expect, it } from "vitest";
import type { FlatTree } from "@fanos/dsl";

/** Tabs over two lists that sit side by side in the data. */
const tree: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
    { id: "t1", parent: "root", idx: 0, type: "Stack", src: "1:2", props: { select: { key: "view", value: "results" } } },
    { id: "t2", parent: "root", idx: 1, type: "Stack", src: "1:3", props: { select: { key: "view", value: "upcoming" } } },
    { id: "rep", parent: "root", idx: 2, type: "Repeater", src: "1:4", props: { over: "table.{_page.view}", as: "row" } },
    { id: "txt", parent: "rep", idx: 0, type: "Text", src: "1:5", props: { content: "{row.name}" } },
  ],
} as never;
const data = { table: { results: [{ name: "Alpha" }], upcoming: [{ name: "Beta" }, { name: "Gamma" }] } };

async function html(page?: Record<string, string>): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(createElement(Render, { tree, data, ...(page ? { page } : {}) } as never));
}

describe("a list that follows a page choice draws the list of each option", () => {
  it("draws the list of the option the page is at, and the other's only when the page is at it", async () => {
    const results = await html({ view: "results" });
    expect(results).toContain("Alpha");
    expect(results).not.toContain("Beta");
    const upcoming = await html({ view: "upcoming" });
    for (const name of ["Beta", "Gamma"]) expect(upcoming).toContain(name);
    expect(upcoming).not.toContain("Alpha");
  });
});

/** Tabs (or a toggle) over ONE list, each item carrying the value of the option it belongs to. */
const filtered = (field: string, key: string, options: string[]): FlatTree =>
  ({
    schemaVersion: "1.0.0",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      ...options.map((value, i) => ({
        id: `tab${i}`,
        parent: "root",
        idx: i,
        type: "Stack",
        src: `1:t${i}`,
        props: { select: { key, value } },
      })),
      { id: "rep", parent: "root", idx: options.length, type: "Repeater", src: "1:r", props: { over: "feed.items", as: "it" } },
      {
        id: "card",
        parent: "rep",
        idx: 0,
        type: "Stack",
        src: "1:c",
        props: { when: { path: `it.${field}`, eqPath: `_page.${key}` } },
      },
      { id: "txt", parent: "card", idx: 0, type: "Text", src: "1:x", props: { content: "{it.title}" } },
    ],
  }) as never;

async function draw(t: FlatTree, items: unknown[], page: Record<string, string>): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(createElement(Render, { tree: t, data: { feed: { items } }, page } as never));
}

describe("a list the choice filters, by a field of its items", () => {
  it("tabs over a news list draw the items of the chosen category", async () => {
    const t = filtered("category", "tab", ["all", "news", "video"]);
    const items = [
      { title: "Match report", category: "news" },
      { title: "Goal replay", category: "Video" },
      { title: "Press day", category: "news" },
    ];
    const news = await draw(t, items, { tab: "news" });
    expect(news).toContain("Match report");
    expect(news).toContain("Press day");
    expect(news).not.toContain("Goal replay");
    // "Video" in the feed and `video` in the tabs are one value
    expect(await draw(t, items, { tab: "video" })).toContain("Goal replay");
  });

  it("a toggle over results and upcoming matches draws the matches of the chosen state", async () => {
    const t = filtered("state", "view", ["results", "upcoming"]);
    const items = [
      { title: "A beat B", state: "results" },
      { title: "C v D", state: "upcoming" },
    ];
    const results = await draw(t, items, { view: "results" });
    expect(results).toContain("A beat B");
    expect(results).not.toContain("C v D");
    const upcoming = await draw(t, items, { view: "upcoming" });
    expect(upcoming).toContain("C v D");
    expect(upcoming).not.toContain("A beat B");
  });
});

describe("lists side by side follow a choice wherever it is written", () => {
  /** The list alone: the toggle that writes `conf` is another section's. */
  const listOnly = (over: string, wrap?: { over: string; as: string }): FlatTree =>
    ({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "root", parent: null, idx: 0, type: "Stack", src: "2:1", props: {} },
        ...(wrap ? [{ id: "outer", parent: "root", idx: 0, type: "Repeater", src: "2:0", props: wrap }] : []),
        { id: "rep", parent: wrap ? "outer" : "root", idx: 0, type: "Repeater", src: "2:2", props: { over, as: "row" } },
        { id: "txt", parent: "rep", idx: 0, type: "Text", src: "2:3", props: { content: "[{row.name}]" } },
      ],
    }) as never;
  const drawn = async (t: FlatTree, d: unknown, page: Record<string, string> = {}) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Render } = await import("../src/components/Render.js");
    const html = renderToStaticMarkup(createElement(Render, { tree: t, data: d, page } as never));
    return [...html.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  };
  const standings = { standings: { East: [{ name: "Celtics" }, { name: "Knicks" }], west: [{ name: "Nuggets" }] } };

  it("draws the list the page is at when no option is in this tree", async () => {
    expect(await drawn(listOnly("standings.{_page.conf}"), standings, { conf: "west" })).toEqual(["Nuggets"]);
    expect(await drawn(listOnly("standings.{_page.conf}"), standings, { conf: "east" })).toEqual(["Celtics", "Knicks"]);
  });

  it("draws every list for an option that names none (ALL), or before any choice", async () => {
    const every = ["Celtics", "Knicks", "Nuggets"];
    expect(await drawn(listOnly("standings.{_page.conf}"), standings, { conf: "all" })).toEqual(every);
    expect(await drawn(listOnly("standings.{_page.conf}"), standings)).toEqual(every);
  });

  it("draws a list once when two options or keys normalise alike", async () => {
    const t = tree; // the tabs `results` and `upcoming`, written here
    const dup = { table: { results: [{ name: "Alpha" }], Results: [{ name: "Again" }], upcoming: [{ name: "Beta" }] } };
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Render } = await import("../src/components/Render.js");
    const html = renderToStaticMarkup(createElement(Render, { tree: t, data: dup, page: { view: "results" } } as never));
    expect(html.match(/Alpha/g)).toHaveLength(1);
    expect(html).not.toContain("Again");
  });

  it("reads the lists in the item's scope inside another Repeater, and a key with a dot as one", async () => {
    const venues = { venues: [{ days: { sat: [{ name: "Gig" }], sun: [{ name: "Market" }] } }, { days: { sat: [{ name: "Fair" }] } }] };
    expect(await drawn(listOnly("venue.days.{_page.day}", { over: "venues", as: "venue" }), venues, { day: "sat" })).toEqual([
      "Gig",
      "Fair",
    ]);
    const seasons = { seasons: { "2024.25": [{ name: "Old" }], "2025.26": [{ name: "New" }] } };
    expect(await drawn(listOnly("seasons.{_page.season}"), seasons, { season: "2025_26" })).toEqual(["New"]);
  });
});

describe("a filtered list: an option no item holds shows every item", () => {
  it("ALL over a news list draws every article", async () => {
    const t = filtered("category", "tab", ["all", "news", "video"]);
    const items = [
      { title: "Match report", category: "news" },
      { title: "Goal replay", category: "Video" },
    ];
    const all = await draw(t, items, { tab: "all" });
    expect(all).toContain("Match report");
    expect(all).toContain("Goal replay");
    expect(await draw(t, items, { tab: "news" })).not.toContain("Goal replay");
  });
});

describe("in the browser, pressing an option switches the list", () => {
  let browser: import("playwright").Browser | undefined;
  afterAll(async () => browser?.close());

  it("follows a choice another section writes: lists side by side, and a filter with ALL", async () => {
    const { chromium } = await import("playwright");
    const { build } = await import("esbuild");
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { pageDefaults } = await import("@fanos/dsl");
    const { Render } = await import("../src/components/Render.js");
    const tab = (id: string, idx: number, key: string, value: string, initial = false) => [
      {
        id,
        parent: "bar",
        idx,
        type: "Stack",
        src: `1:${idx + 2}`,
        props: { select: { key, value, ...(initial ? { initial: true } : {}) } },
      },
      { id: `${id}_label`, parent: id, idx: 0, type: "Text", src: `1:${idx + 20}`, props: { content: value.toUpperCase() } },
    ];
    /** The header: EAST | WEST, and ALL | NEWS | VIDEO. Two choices, no data. */
    const HEADER = {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "bar", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row" } },
        ...tab("east", 0, "conf", "east", true),
        ...tab("west", 1, "conf", "west"),
        ...tab("all", 2, "tab", "all", true),
        ...tab("news", 3, "tab", "news"),
        ...tab("video", 4, "tab", "video"),
      ],
    } as FlatTree;
    /** Another section: the standings by conference, side by side; the articles, filtered. */
    const BODY = {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "body", parent: null, idx: 0, type: "Stack", src: "2:1", props: {} },
        { id: "teams", parent: "body", idx: 0, type: "Repeater", src: "2:2", props: { over: "standings.{_page.conf}", as: "t" } },
        { id: "team", parent: "teams", idx: 0, type: "Text", src: "2:3", props: { content: "{t.name}" } },
        { id: "posts", parent: "body", idx: 1, type: "Repeater", src: "2:4", props: { over: "feed.items", as: "a" } },
        { id: "post", parent: "posts", idx: 0, type: "Text", src: "2:5", props: { content: "{a.title}", when: { path: "a.kind", eqPath: "_page.tab" } } },
      ],
    } as FlatTree;
    const DATA = {
      standings: { East: [{ name: "Celtics" }, { name: "Knicks" }], West: [{ name: "Nuggets" }] },
      feed: { items: [{ title: "Report", kind: "News" }, { title: "Replay", kind: "video" }, { title: "Preview", kind: "news" }] },
    };
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { hydrateRoot } from "react-dom/client";
          import { Render } from "./src/components/Render.tsx";
          window.fosHydrate = (id, props) => hydrateRoot(document.getElementById(id), createElement(Render, props));`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      alias: { "@fanos/renderer/client": "./src/client.tsx" },
      plugins: [
        {
          name: "no-fs",
          setup(b) {
            b.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: "fs", namespace: "stub" }));
            b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents: "export const readFileSync = () => { throw new Error('no fs in a page'); };",
            }));
          },
        },
      ],
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "error",
    });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const start = pageDefaults([HEADER, BODY]);
    await page.setContent(
      `<div id="header">${renderToString(createElement(Render, { tree: HEADER, page: start }))}</div>` +
        `<div id="body">${renderToString(createElement(Render, { tree: BODY, data: DATA, page: start }))}</div>`,
    );
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(
      ({ header, body, data, start }) => {
        const w = window as unknown as { fosHydrate: (id: string, p: unknown) => void };
        w.fosHydrate("header", { tree: header, page: start });
        w.fosHydrate("body", { tree: body, data, page: start });
      },
      { header: HEADER, body: BODY, data: DATA, start },
    );
    const teams = () => page.locator('[data-fos-id="team"]').allTextContents();
    const posts = () => page.locator('[data-fos-id="post"]').allTextContents();

    expect(await teams()).toEqual(["Celtics", "Knicks"]);
    expect(await posts()).toEqual(["Report", "Replay", "Preview"]);
    await page.locator('[data-fos-id="west"]').click();
    expect(await teams()).toEqual(["Nuggets"]);
    await page.locator('[data-fos-id="news"]').click();
    expect(await posts()).toEqual(["Report", "Preview"]);
    await page.locator('[data-fos-id="video"]').click();
    expect(await posts()).toEqual(["Replay"]);
    await page.locator('[data-fos-id="all"]').click();
    expect(await posts()).toEqual(["Report", "Replay", "Preview"]);
    await page.locator('[data-fos-id="east"]').click();
    expect(await teams()).toEqual(["Celtics", "Knicks"]);
    expect(errors).toEqual([]);
  });
});
