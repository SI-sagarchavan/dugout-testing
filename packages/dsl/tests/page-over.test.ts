import { describe, expect, it } from "vitest";
import {
  checkBindings,
  evaluateCondition,
  evaluateWhen,
  itemScope,
  overChoice,
  overFor,
  overList,
  overLists,
  pageScope,
  pageValueOf,
  splitPageWhen,
} from "../src/index.js";
import type { FlatTree } from "../src/index.js";

/** A toggle over two lists that sit side by side in the data: not a squad, a table of anything. */
const tree = (over = "table.{_page.view}", options = ["results", "upcoming"]): FlatTree =>
  ({
    schemaVersion: "1.0.0",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      ...options.map((value, i) => ({
        id: `t${i}`,
        parent: "root",
        idx: i,
        type: "Stack",
        src: `1:t${i}`,
        props: { select: { key: "view", value } },
      })),
      { id: "rep", parent: "root", idx: options.length, type: "Repeater", src: "1:4", props: { over, as: "row" } },
      { id: "txt", parent: "rep", idx: 0, type: "Text", src: "1:5", props: { content: "{row.name}" } },
    ],
  }) as never;

/** The list alone: the toggle is drawn by another section of the page. */
const listOnly = (over: string, wrap?: { over: string; as: string }): FlatTree =>
  ({
    schemaVersion: "1.0.0",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "2:1", props: {} },
      ...(wrap ? [{ id: "outer", parent: "root", idx: 0, type: "Repeater", src: "2:0", props: wrap }] : []),
      { id: "rep", parent: wrap ? "outer" : "root", idx: 0, type: "Repeater", src: "2:2", props: { over, as: "row" } },
      { id: "txt", parent: "rep", idx: 0, type: "Text", src: "2:3", props: { content: "{row.name}" } },
    ],
  }) as never;

const data = { table: { results: [{ name: "A" }], Upcoming: [{ name: "B" }, { name: "C" }] } };
const errors = (t: FlatTree, d: unknown, o?: Parameters<typeof checkBindings>[2]) =>
  checkBindings(t, d, o).filter((i) => i.severity === "error");

describe("a Repeater whose list follows a page choice", () => {
  it("names the choice it reads, and the list of each option (by the key the data has)", () => {
    expect(overChoice("table.{_page.view}")).toBe("view");
    expect(overChoice("table.items")).toBeUndefined();
    expect(overFor("table.{_page.view}", data, "upcoming")).toBe("table.Upcoming");
    expect(overFor("table.{_page.view}", data, "results")).toBe("table.results");
    expect(overFor("table.{_page.view}", data, "other")).toBe("table.other");
  });

  it("is valid when every option names a list, and says which option names none", () => {
    expect(errors(tree(), data)).toEqual([]);
    const lacking = checkBindings(tree(), { table: { results: [{ name: "A" }] } });
    expect(lacking.map((i) => i.message).join("\n")).toContain('the option "upcoming" names no list');
  });

  it("reads a choice another section writes: the data's lists are its options", () => {
    // standings by conference, the toggle in the header above: nothing in this tree writes `conf`
    const standings = { standings: { east: [{ name: "Celtics" }], west: [{ name: "Nuggets" }] } };
    expect(errors(listOnly("standings.{_page.conf}"), standings)).toEqual([]);
    expect(checkBindings(listOnly("standings.{_page.conf}"), standings)).toEqual([]);
    // the known options of the page are checked too
    const known = checkBindings(listOnly("standings.{_page.conf}"), standings, {
      choices: [{ key: "conf", options: [{ value: "east" }, { value: "west" }, { value: "central" }] }],
    });
    expect(known.map((i) => i.message).join("\n")).toContain('the option "central" names no list');
    // and with no list there at all, it is an error
    expect(errors(listOnly("standings.{_page.conf}"), { standings: { title: "x" } })[0]?.message).toContain(
      "holds no list under any key",
    );
    expect(errors(listOnly("table.{_page.nothing}"), { other: [] })[0]?.message).toContain('"table" is not in the data');
  });

  it("reads the lists in the Repeater's own scope inside another Repeater", () => {
    // each venue's events, by day: the parent of the lists is the outer item, not the root
    const venues = { venues: [{ days: { sat: [{ name: "Gig" }], sun: [{ name: "Market" }] } }] };
    expect(errors(listOnly("venue.days.{_page.day}", { over: "venues", as: "venue" }), venues)).toEqual([]);
    expect(overLists("venue.days.{_page.day}", { venue: venues.venues[0] }).map((l) => l.value)).toEqual(["sat", "sun"]);
  });

  it("reads an option with a dot in it as one key", () => {
    const seasons = { seasons: { "2024.25": [{ name: "Old" }], "2025.26": [{ name: "New" }] } };
    expect(overList("seasons.{_page.season}", seasons, pageValueOf("2025.26"))).toEqual([{ name: "New" }]);
    expect(errors(tree("seasons.{_page.view}", ["2024.25", "2025.26"]), seasons)).toEqual([]);
  });

  it("an option that names no list (ALL) draws every list; keys that normalise alike are one", () => {
    const feed = { feed: { news: [{ name: "N" }], Videos: [{ name: "V" }], videos: [{ name: "dup" }] } };
    expect(overLists("feed.{_page.tab}", feed).map((l) => l.value)).toEqual(["news", "Videos"]);
    expect(overList("feed.{_page.tab}", feed, "all")).toEqual([{ name: "N" }, { name: "V" }]);
    expect(overList("feed.{_page.tab}", feed, undefined)).toEqual([{ name: "N" }, { name: "V" }]);
    expect(overList("feed.{_page.tab}", feed, "videos")).toEqual([{ name: "V" }]);
    const all = checkBindings(tree("feed.{_page.view}", ["all", "news", "videos"]), feed);
    expect(all.filter((i) => i.severity === "error")).toEqual([]);
    expect(all.map((i) => i.message).join("\n")).toContain('"all" names no list');
  });
});

describe("a list a choice filters: an option no item holds shows every item", () => {
  // tabs ALL / NEWS / VIDEO over one list of articles; a toggle HOME / AWAY over fixtures
  const articles = [
    { title: "Report", category: "news" },
    { title: "Replay", category: "Video" },
    { title: "Preview", category: "news" },
  ];
  const filter = { path: "it.category", eqPath: "_page.tab" };
  const drawn = (tab: string | undefined) =>
    articles
      .filter((a) =>
        evaluateCondition(filter, { ...itemScope({}, "it", a, articles), ...pageScope(tab === undefined ? {} : { tab }) }),
      )
      .map((a) => a.title);

  it("draws the items of the chosen option, and every item for one no item holds", () => {
    expect(drawn("news")).toEqual(["Report", "Preview"]);
    expect(drawn("video")).toEqual(["Replay"]);
    expect(drawn("all")).toEqual(["Report", "Replay", "Preview"]);
    expect(drawn(undefined)).toEqual(["Report", "Replay", "Preview"]);
  });

  it("outside a list, the page and a field are only equal", () => {
    expect(evaluateWhen(filter, { it: articles[0], ...pageScope({ tab: "all" }) })).toBe(false);
  });

  it("splits for the browser into what the page must not be", () => {
    const fixtures = [
      { opponent: "Rovers", venue: "Home" },
      { opponent: "United", venue: "Away" },
      { opponent: "City" },
    ];
    const when = { path: "f.venue", eqPath: "_page.where" };
    const split = (f: (typeof fixtures)[number]) => splitPageWhen(when, itemScope({}, "f", f, fixtures)).page;
    expect(split(fixtures[0]!)).toEqual([{ path: "_page.where", ne: "Away" }]);
    expect(split(fixtures[2]!)).toEqual([
      { path: "_page.where", ne: "Home" },
      { path: "_page.where", ne: "Away" },
    ]);
    const shown = (where: string) =>
      fixtures.filter((f) => split(f).every((c) => evaluateCondition(c, pageScope({ where })))).map((f) => f.opponent);
    expect(shown("home")).toEqual(["Rovers"]);
    expect(shown("away")).toEqual(["United"]);
    expect(shown("both")).toEqual(["Rovers", "United", "City"]);
  });
});
