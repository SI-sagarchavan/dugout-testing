import { describe, expect, it } from "vitest";
import {
  behaviourObligations,
  bindingObligations,
  countedSources,
  linkedSources,
  pagedLists,
} from "../src/obligations.ts";

// run 7dafe3b0: a paged hook on its last page (7 galleries, next: null). data-bind bound the cards
// by position only and interaction left LOAD MORE unwired, each because "the feed has one page"
const PAGED = { galleries: { galleries: [{ id: 1 }, { id: 2 }], next: null } };
const POSITIONAL = {
  bind: [
    { src: "a", path: "galleries.galleries.0.title", prop: "content" },
    { src: "b", path: "galleries.galleries.1.title", prop: "content" },
  ],
};
const OPEN = {
  ...POSITIONAL,
  collapse: [{ over: "galleries.galleries", as: "g", members: ["c"], slice: [2] }],
};

describe("pagedLists", () => {
  it("reads a source whose top answers next, on its last page too", () => {
    expect(pagedLists(PAGED)).toEqual([{ source: "galleries", list: "galleries.galleries" }]);
  });

  it("reads nothing from a source that does not page", () => {
    expect(pagedLists({ news: { items: [{ id: 1 }] } })).toEqual([]);
    expect(pagedLists(undefined)).toEqual([]);
  });
});

describe("bindingObligations", () => {
  it("refuses a plan that binds a paged list by position only, whatever next holds", () => {
    const open = bindingObligations(POSITIONAL, PAGED);
    expect(open).toHaveLength(1);
    expect(open[0]?.source).toBe("galleries");
    expect(open[0]?.problem).toMatch(/open slice \[n\]/);
  });

  it("is met by a collapse over the list from an index on", () => {
    expect(bindingObligations(OPEN, PAGED)).toEqual([]);
  });

  it("is not met by a closed slice", () => {
    const closed = { ...POSITIONAL, collapse: [{ over: "galleries.galleries", slice: [0, 2] }] };
    expect(bindingObligations(closed, PAGED)).toHaveLength(1);
  });

  it("asks nothing of a plan that does not read the paged list, or of unpaged data", () => {
    expect(bindingObligations({ bind: [{ path: "news.items.0.title" }] } as never, PAGED)).toEqual(
      [],
    );
    expect(bindingObligations(POSITIONAL, { galleries: { galleries: [] } })).toEqual([]);
  });
});

describe("behaviourObligations", () => {
  const machine = { requests: { next_page: { source: "galleries" } } };
  const hides = [{ src: "more", prop: "when", value: { path: "galleries.next", exists: true } }];

  it("refuses a section with no request for the next page", () => {
    const open = behaviourObligations(OPEN, PAGED, { layers: [] });
    expect(open).toHaveLength(1);
    expect(open[0]?.problem).toMatch(/asks for no next page/);
  });

  it("refuses a request with no button drawn on next", () => {
    expect(behaviourObligations(OPEN, PAGED, { machine, layers: [] })[0]?.problem).toMatch(
      /nothing is drawn on its next/,
    );
  });

  it("is met by a request for the source and a layer drawn on its next", () => {
    expect(behaviourObligations(OPEN, PAGED, { machine, layers: hides })).toEqual([]);
  });
});

describe("the fixed count", () => {
  // a strip of 4 news cards over a hook that gives 20: a collapse with no slice draws all 20
  const NEWS = { news: { items: Array.from({ length: 20 }, (_, i) => ({ id: i })) } };
  const asked = [
    { input: { need: { list: "news", count: 4 } }, output: { hookId: "dugout_news" } },
  ];
  const counted = countedSources(asked, [{ as: "news", hookId: "dugout_news" }]);

  it("reads the count the run asked hook-maker for, by the hook bound", () => {
    expect(counted).toEqual([{ source: "news", count: 4 }]);
  });

  it("reads no count for a paged, grouped or open-ended need", () => {
    for (const need of [
      { list: "g", count: 10, paged: true },
      { list: "f", count: 3, groupBy: "date" },
      { list: "v", count: "data" },
    ])
      expect(
        countedSources([{ input: { need }, output: { hookId: "h" } }], [{ as: "s", hookId: "h" }]),
      ).toEqual([]);
  });

  it("refuses a collapse that draws every item, whatever the feed holds today", () => {
    const plan = { collapse: [{ over: "news.items", as: "n", members: ["c"] }] };
    const open = bindingObligations(plan, NEWS, { counted });
    expect(open).toHaveLength(1);
    expect(open[0]?.problem).toMatch(/draws 4 of news.items.*every item/);
    // fewer items today is no reason: the feed grows
    expect(bindingObligations(plan, { news: { items: [{ id: 1 }] } }, { counted })).toHaveLength(1);
  });

  it("refuses a slice past the count and a card bound past it by position", () => {
    const past = { collapse: [{ over: "news.items", slice: [0, 6] }] };
    expect(bindingObligations(past, NEWS, { counted })[0]?.problem).toMatch(/runs to item 6/);
    const placed = { bind: [{ src: "x", path: "news.items.5.title" }] };
    expect(bindingObligations(placed, NEWS, { counted })[0]?.problem).toMatch(/item 5 by position/);
  });

  it("is met by a closed slice within the count, or positions below it", () => {
    const cut = {
      bind: [{ src: "lead", path: "news.items.0.title" }],
      collapse: [{ over: "news.items", slice: [1, 4] }],
    };
    expect(bindingObligations(cut, NEWS, { counted })).toEqual([]);
  });
});

describe("a list that shrinks", () => {
  // a mosaic of two cards bound by position: tomorrow's feed may hold one item, or none
  const NODES = [
    { id: "r", parent: null, src: "root", props: {} },
    { id: "c0", parent: "r", src: "card0", props: {} },
    { id: "t0", parent: "c0", src: "title0", props: {} },
    { id: "c1", parent: "r", src: "card1", props: {} },
    { id: "t1", parent: "c1", src: "title1", props: {} },
  ];
  const BIND = [
    { src: "title0", path: "news.items.0.title" },
    { src: "title1", path: "news.items.1.title" },
  ];
  const DATA = { news: { items: [{ title: "a" }, { title: "b" }] } };

  it("refuses cards bound by position that nothing hides when their item is gone", () => {
    const open = bindingObligations({ bind: BIND }, DATA, {}, NODES);
    expect(open).toHaveLength(1);
    expect(open[0]?.problem).toMatch(/items 0, 1/);
  });

  it("is met by a when on the card that reads its own item", () => {
    const set = [0, 1].map((n) => ({
      src: `card${n}`,
      prop: "when",
      value: { path: `news.items.${n}`, exists: true },
    }));
    expect(bindingObligations({ bind: BIND, set }, DATA, {}, NODES)).toEqual([]);
  });

  it("is not met by a when on another item", () => {
    const set = [{ src: "card1", prop: "when", value: { path: "news.items.0", exists: true } }];
    expect(bindingObligations({ bind: BIND, set }, DATA, {}, NODES)[0]?.problem).toMatch(
      /item 0, 1|items 0, 1/,
    );
  });
});

describe("links", () => {
  const asked = [
    {
      input: {
        need: {
          list: "news",
          count: 4,
          item: [{ field: "title" }, { field: "page", kind: "link" }],
        },
      },
      output: { hookId: "dugout_news" },
    },
  ];
  const linked = linkedSources(asked, [{ as: "news", hookId: "dugout_news" }]);
  const DATA = { news: { items: [{ title: "a", slug: "a" }] } };
  const cards = { over: "news.items", as: "n", members: ["card"], slice: [0, 4] };

  it("reads the sources whose items were asked for a link", () => {
    expect(linked).toEqual(["news"]);
    expect(
      linkedSources(
        [{ input: { need: { item: [{ field: "t" }] } }, output: { hookId: "h" } }],
        [{ as: "s", hookId: "h" }],
      ),
    ).toEqual([]);
  });

  it("refuses a plan that binds the cards and links none of them", () => {
    const plan = {
      collapse: [{ ...cards, fields: [{ src: "title", prop: "content", path: "n.title" }] }],
    };
    expect(bindingObligations(plan, DATA, { linked })[0]?.problem).toMatch(
      /nothing in the plan links them/,
    );
  });

  it("is met by an href on the card, by path or by a route template", () => {
    for (const field of [
      { src: "card", prop: "href", path: "n.url" },
      { src: "card", prop: "href", template: "/news/{n.slug}" },
    ])
      expect(
        bindingObligations({ collapse: [{ ...cards, fields: [field] }] }, DATA, { linked }),
      ).toEqual([]);
  });
});

describe("a carousel", () => {
  // frame-match settled the strip as a carousel: its slides are as many as the data holds
  const NODES = [
    { id: "r", parent: null, type: "Stack", src: "root", props: {} },
    { id: "car", parent: "r", type: "Carousel", src: "strip", props: {} },
    { id: "s0", parent: "car", type: "Stack", src: "slide0", props: {} },
    { id: "s1", parent: "car", type: "Stack", src: "slide1", props: {} },
  ];
  const DATA = { videos: { items: [{ t: "a" }, { t: "b" }, { t: "c" }] } };

  it("refuses a carousel's list cut to the slides the design drew", () => {
    const plan = {
      collapse: [{ over: "videos.items", as: "v", members: ["slide0", "slide1"], slice: [0, 2] }],
    };
    expect(bindingObligations(plan, DATA, {}, NODES)[0]?.problem).toMatch(
      /carousel strip draws videos.items cut/,
    );
  });

  it("refuses slides bound by position", () => {
    const plan = {
      bind: [{ src: "slide0", path: "videos.items.0.t" }],
      set: [{ src: "slide0", prop: "when", value: { path: "videos.items.0", exists: true } }],
    };
    expect(
      bindingObligations(plan, DATA, {}, NODES)
        .map((o) => o.problem)
        .join(" "),
    ).toMatch(/bound to videos's items by position/);
  });

  it("is met by a collapse that cuts nothing, and yields to a fixed count", () => {
    const whole = { collapse: [{ over: "videos.items", as: "v", members: ["slide0", "slide1"] }] };
    expect(bindingObligations(whole, DATA, {}, NODES)).toEqual([]);
    const cut = {
      collapse: [{ over: "videos.items", as: "v", members: ["slide0", "slide1"], slice: [0, 2] }],
    };
    expect(
      bindingObligations(cut, DATA, { counted: [{ source: "videos", count: 2 }] }, NODES),
    ).toEqual([]);
  });
});
