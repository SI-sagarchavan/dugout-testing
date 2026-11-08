import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { asBag, indexIr, loadDsl } from "../src/dsl.ts";
import {
  dryRun,
  groups,
  leftAsDesigned,
  outline,
  ownPictures,
  rowsOf,
  shapeOf,
  someOnly,
  unboundCopy,
} from "../src/facts.ts";
import { Plan, previewOf, problemsOf } from "../src/tools.ts";

/**
 * The fixtures strip: the tree frame-match published, its Figma IR, the dummy Cast response, and the
 * plan written by hand for it, which is the answer the agent is checked against.
 */
const read = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
const tree = read("agents/data-bind/tests/fixtures/fixtures-strip.tree.json");
const byId = indexIr(read("packages/conform/fixtures/ir/fixtures-strip.ir.json").root);
const reference = read("apps/api/data/fixtures-strip-plan.json");
const dsl = await loadDsl();
const sample = read("apps/api/data/fixtures-strip.json");
// the sample's first upcoming match is re-armed to start in a minute (apps/api/scripts/arm-countdown.mjs):
// the tests keep their own start time
for (const day of sample.fixtures.castFlow.data["1"]) {
  for (const match of day.matches) {
    if (match.match_id === "900103") match.start_time = "2026-11-17T14:30:00+00:00";
  }
}
const bag = asBag(sample, dsl);

const check = (plan: unknown) => {
  const applied = dsl.applyBindingPlan(tree, plan);
  const run = dryRun(applied.tree, bag, dsl, tree, Date.parse("2026-11-15T12:17:27Z"));
  return {
    applied,
    run,
    problems: problemsOf(
      applied,
      dsl.check(applied.tree),
      run,
      plan as never,
      tree,
      leftAsDesigned(tree, applied.tree, byId, dsl.hasRef),
      unboundCopy(applied.tree, dsl.hasRef),
    ),
  };
};

describe("the frame's facts", () => {
  it("finds the cards as one component in two shapes, and the matches inside a card", () => {
    const found = groups(tree, byId);
    expect(found[0]).toEqual({
      parent: "35:10545",
      members: ["35:10546", "35:10547", "35:10548"],
      shapes: [["35:10546"], ["35:10547", "35:10548"]],
      component: "D_2 Fixture Card",
    });
    expect(found).toContainEqual({
      parent: "I35:10546;18621:42500",
      members: ["I35:10546;18621:42501", "I35:10546;18621:42524"],
      shapes: [["I35:10546;18621:42501", "I35:10546;18621:42524"]],
    });
  });

  it("does not call a value and its unit beside it a list", () => {
    // "166/5" and "(100 Balls)": two texts, one shape, not a list
    expect(groups(tree, byId).some((g) => g.members.includes("I35:10546;18621:42512"))).toBe(false);
  });

  it("writes an outline a model can name nodes from, short enough to read", () => {
    const lines = outline(tree, byId);
    expect(lines.length).toBeLessThan(100);
    expect(lines).toContain('                  I35:10546;18621:42503 Text "RECENT"');
    expect(lines.some((l) => l.includes("35:10548 Stack — same shape as 35:10547"))).toBe(true);
  });
});

describe("the data's shape", () => {
  const lines = shapeOf(bag);
  it("lists the few values a variant can be chosen by", () => {
    expect(lines).toContain(
      'fixtures.items[].matches[].state  string one of "result"×5, "live"×1, "abandoned"×1, "upcoming"×2',
    );
  });
  it("marks the instants a clock can count to", () => {
    expect(lines.find((l) => l.startsWith("fixtures.items[].matches[].start_time"))).toMatch(
      /^fixtures\.items\[\]\.matches\[\]\.start_time {2}string \(instant\)/,
    );
    expect(lines.find((l) => l.startsWith("fixtures.items[].date "))).not.toContain("instant");
  });

  it("says which fields some items lack", () => {
    expect(lines.find((l) => l.startsWith("fixtures.items[].matches[].tickets_url"))).toContain(
      "present 2/9",
    );
  });
});

describe("a plan drawn against the sample", () => {
  it("finds nothing wrong with the reference plan, and draws every day and match", () => {
    expect(Plan.safeParse(reference).success).toBe(true);
    const { run, problems } = check(reference);
    expect(problems).toEqual([]);
    expect(run.repeats).toEqual([
      { template: "35:10546", over: "fixtures.items", items: 7, most: 7 },
      { template: "I35:10546;18621:42501", over: "day.matches", items: 9, most: 2 },
    ]);
  });

  it("reports items that draw no variant", () => {
    const plan = structuredClone(reference);
    plan.collapse[0].when = { path: "match.state", eq: "result" };
    const { problems } = check(plan);
    // live and abandoned now match neither shape
    expect(problems.some((p) => p.includes("draw no variant"))).toBe(true);
  });

  it("reports a path the data does not have, and a field some items lack", () => {
    const plan = structuredClone(reference);
    plan.collapse[0].fields.push({
      src: "I35:10546;18621:42523",
      prop: "content",
      path: "outcome",
    });
    plan.set = plan.set.filter(
      (s: { src: string; prop: string }) =>
        !(s.src === "I35:10546;18621:42523" && s.prop === "when"),
    );
    const { problems } = check(plan);
    expect(problems.some((p) => p.includes("nothing at match.outcome"))).toBe(true);
  });

  it("reports a value that is null for some items, as a hole on the page", () => {
    const plan = structuredClone(reference);
    const scores = plan.collapse[0].fields.filter((f: { template?: string }) =>
      f.template?.includes("default"),
    );
    for (const field of scores) field.template = field.template.replace(/ \| default:"[^"]*"/, "");
    const { problems } = check(plan);
    expect(problems.some((p) => p.includes("has nothing at match.teams.0.score"))).toBe(true);
  });

  it("reports data in lower case where the design writes capitals", () => {
    const plan = structuredClone(reference);
    plan.set = plan.set.filter(
      (s: { src: string; prop: string }) =>
        !(s.src === "I35:10546;18621:42503" && s.prop === "textCase"),
    );
    const { problems } = check(plan);
    expect(problems).toContain(
      'I35:10546;18621:42503 shows "Recent" where the design writes capitals ("RECENT"): set textCase "upper"',
    );
  });

  it("reports the looks a collapse would lose: the second team drawn like the first", () => {
    const plan = structuredClone(reference);
    plan.collapse.unshift({
      over: "match.teams",
      as: "team",
      members: ["I35:10546;18621:42507", "I35:10546;18621:42514"],
    });
    const { problems } = check(plan);
    expect(problems[0]).toContain(
      'I35:10546;18621:42520 tone "color.text_main_prim" where I35:10546;18621:42512 has "color.text_main_sec"',
    );
  });

  it("draws the countdown from each match's start, at the time it is read", () => {
    const { run } = check(reference);
    // 2026-11-15 12:17:27 UTC: 2d 2h 12m 33s before the 14:30 match
    const shows = (src: string) => run.samples.find((s) => s.src === src)?.values;
    expect(shows("I35:10547;18621:42579")).toEqual(["02"]);
    // the 18:00 match is 3h 30m later
    expect(shows("I35:10547;18621:42585")).toEqual(["02", "05"]);
    expect(run.samples.find((s) => s.src === "I35:10547;18621:42597")?.values).toEqual(["33"]);
  });

  it("switches a started match to the result card, by its clock", () => {
    const at = (iso: string) => {
      const applied = dsl.applyBindingPlan(tree, reference);
      return dryRun(applied.tree, bag, dsl, tree, Date.parse(iso));
    };
    // before the 14:30 and 18:00 starts: two countdown cards, no variant problems
    expect(at("2026-11-17T12:00:00Z").variants).toEqual([]);
    expect(
      at("2026-11-17T12:00:00Z").samples.find((s) => s.src === "I35:10547;18621:42579")?.values,
    ).toEqual(["00"]);
    // after the first start only: its digits are gone, and one card is still counting
    const after = at("2026-11-17T14:30:30Z");
    expect(after.variants).toEqual([]);
    expect(after.samples.find((s) => s.src === "I35:10547;18621:42597")?.values).toEqual(["30"]);
  });

  it("reports figures the design wrote that every item would show", () => {
    const plan = structuredClone(reference);
    plan.collapse[0].variants[0].fields = plan.collapse[0].variants[0].fields.filter(
      (f: { template?: string }) => !f.template?.includes("countdown"),
    );
    const { problems } = check(plan);
    expect(problems).toContain(
      'I35:10547;18621:42579 shows the design\'s "02" in all 2 items it draws in: a placeholder. Bind it to what it stands for (time left until an instant is a clock), or say in remaining why it stays',
    );
  });

  it("reports a clock that reads no instant", () => {
    const plan = structuredClone(reference);
    const clock = plan.set.find(
      (s: { src: string; prop: string }) => s.src === "I35:10547;18621:42553" && s.prop === "clock",
    );
    clock.value.to = "{match.kickoff}";
    const { problems } = check(plan);
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^I35:10547;18621:42553 clock reads no instant at "\{match\.kickoff\}" for 9 item\(s\)/,
      ),
    );
  });

  it("reports a node the plan names that the frame does not have", () => {
    const { problems } = check({ bind: [{ src: "9:9", prop: "content", path: "x" }] });
    expect(problems[0]).toMatch(/^not applied: src 9:9/);
  });
});

/**
 * A news grid: one big card, then two rows of two small cards, against a flat list of six. The plan
 * that collapsed only the first row drew all six there and left the second row's Figma pictures and
 * copy on the page.
 */
describe("a grid drawn as rows", () => {
  const grid = read("agents/data-bind/tests/fixtures/news-grid.tree.json");
  const gridIr = indexIr(read("agents/data-bind/tests/fixtures/news-grid.ir.json").root);
  const gridBag = asBag(read("agents/data-bind/tests/fixtures/news-grid.data.json"), dsl);
  const checkGrid = (plan: unknown) => {
    const applied = dsl.applyBindingPlan(grid, plan);
    const run = dryRun(applied.tree, gridBag, dsl, grid);
    const left = leftAsDesigned(grid, applied.tree, gridIr, dsl.hasRef);
    const unbound = unboundCopy(applied.tree, dsl.hasRef);
    return {
      left,
      unbound,
      problems: problemsOf(
        applied,
        dsl.check(applied.tree),
        run,
        plan as never,
        grid,
        left,
        unbound,
      ),
    };
  };

  it("names the cards of every row, not only the first", () => {
    const found = groups(grid, gridIr);
    const rows = found.find((g) => g.parent === "35:10183");
    const cards = found.find((g) => g.parent === "35:10184");
    expect(rows && cards && rowsOf(grid, rows, cards)).toEqual([
      ["35:10185", "35:10186"],
      ["35:10188", "35:10189"],
    ]);
    // the pictures layered in a card are not its items
    const layers = found.find((g) => g.parent === "35:10185");
    expect(cards && layers && rowsOf(grid, cards, layers)).toBeUndefined();
  });

  it("reports a picture bound to a path with no domain", () => {
    const plan = read("agents/data-bind/tests/fixtures/news-grid.plan.json");
    for (const c of plan.collapse)
      for (const f of c.fields)
        if (f.prop === "src") {
          f.path = "image";
          delete f.template;
        }
    const { problems } = checkGrid(plan);
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^I35:10185;10169:11332 src shows "\/static-assets\/media\/.*" for 2 item\(s\): a path with no domain/,
      ),
    );
    // with the domain in front, there is nothing to report
    const ok = read("agents/data-bind/tests/fixtures/news-grid.plan.json");
    expect(checkGrid(ok).problems.filter((p) => p.includes("no domain"))).toEqual([]);
  });

  it("hands the first picture of each node to a reachability probe, whole", () => {
    const applied = dsl.applyBindingPlan(
      grid,
      read("agents/data-bind/tests/fixtures/news-grid.plan.json"),
    );
    const run = dryRun(applied.tree, gridBag, dsl, grid);
    expect(run.pictures[0]).toMatchObject({
      src: "I35:10182;13085:25357",
      url: "https://www.southernbrave.com/static-assets/media/200868ec-e809-4921-9bab-ba57e008e13f.jpg",
    });
    expect(run.pictures[0]?.urls[0]).toBe(run.pictures[0]?.url);
  });

  it("takes a slice on each row's collapse", () => {
    expect(
      Plan.safeParse(read("agents/data-bind/tests/fixtures/news-grid.plan.json")).success,
    ).toBe(true);
  });

  it("reports the row left showing the design, with each row's slice and its own ids", () => {
    const { left, problems } = checkGrid(
      read("agents/data-bind/tests/fixtures/news-grid.one-row.plan.json"),
    );
    expect(left).toEqual([
      {
        src: "35:10187",
        like: "35:10184",
        over: "news.cards",
        copy: "Southern Brave in Women’s Hundred 2023 | Comple…",
        items: ["35:10188", "35:10189"],
        fields: [
          ["I35:10185;10169:11332", "I35:10188;10169:11332"],
          ["I35:10185;10169:11338", "I35:10188;10169:11338"],
          ["I35:10185;10169:11342", "I35:10188;10169:11342"],
        ],
        slices: [
          ["35:10184", [0, 2]],
          ["35:10187", [2, 4]],
        ],
      },
    ]);
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^35:10187 still shows the design's placeholders .*\(35:10184 \[0, 2\], 35:10187 \[2, 4\]\)/,
      ),
    );
    // the first row draws all six cards in a row sized for two
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^news\.cards draws up to 6 items where the design drew 2, in 35:10184: a row/,
      ),
    );
  });

  it("reports nothing overflowing when each row draws its own slice", () => {
    const { problems } = checkGrid(read("agents/data-bind/tests/fixtures/news-grid.plan.json"));
    expect(problems.filter((p) => p.includes("draws up to"))).toEqual([]);
  });

  it("finds nothing left when each row draws its own slice", () => {
    const { left, problems } = checkGrid(
      read("agents/data-bind/tests/fixtures/news-grid.plan.json"),
    );
    expect(left).toEqual([]);
    expect(problems.filter((p) => p.includes("placeholders"))).toEqual([]);
  });

  it("reports design copy left beside bound data, in any container", () => {
    const file = "agents/data-bind/tests/fixtures/news-grid.one-row.plan.json";
    // a plan that binds the big card's title and date but neither binds nor hides its "32"
    const plan = read(file);
    plan.set = [];
    const { unbound, problems } = checkGrid(plan);
    expect(problems).toContainEqual(
      expect.stringMatching(/^I35:10182;13753:35177 still shows the design's "32"/),
    );
    expect(unbound).toContainEqual({
      src: "I35:10182;13753:35177",
      copy: "32",
      within: "I35:10182;13085:25458",
    });
    // hiding it with a when accounts for it
    expect(checkGrid(read(file)).unbound.some((u) => u.copy === "32")).toBe(false);
    // the page's own heading and button are labels, not placeholders
    expect(unbound.some((u) => u.copy === "IN THE FRAME" || u.copy === "VIEW MORE")).toBe(false);
  });

  it("does not call the pictures layered in a card a list left unbound", () => {
    const { left } = checkGrid(read("agents/data-bind/tests/fixtures/news-grid.plan.json"));
    expect(left.some((l) => l.src.startsWith("I35:10182;"))).toBe(false);
  });
});

describe("a picture each card has its own of", () => {
  // the player cards: three of one shape, each with its own photo, and the data has no picture
  const card = (n: number, photo: string) => [
    { id: `card_${n}`, parent: "carousel", idx: n, type: "Overlay", src: `35:${n}`, props: {} },
    {
      id: `photo_${n}`,
      parent: `card_${n}`,
      idx: 0,
      type: "Image",
      src: `I35:${n};1`,
      props: { src: photo, alt: "PLAYER" },
    },
    {
      id: `name_${n}`,
      parent: `card_${n}`,
      idx: 1,
      type: "Text",
      src: `I35:${n};2`,
      props: { content: "Ben McKinney" },
    },
  ];
  const cards = {
    nodes: [
      { id: "carousel", parent: null, idx: 0, type: "Stack", src: "35:0", props: {} },
      ...card(1, "data:image/png;base64,AAA"),
      ...card(2, "data:image/png;base64,BBB"),
      ...card(3, "data:image/png;base64,CCC"),
    ],
  } as never;
  const players = asBag(
    {
      squad: {
        players: [
          { id: "10085", name: "Glenn Maxwell" },
          { id: "11755", name: "Obus Pienaar" },
        ],
      },
    },
    dsl,
  );
  const problems = (fields: unknown[]) => {
    const plan = {
      collapse: [{ over: "squad.players", as: "p", members: ["35:1", "35:2", "35:3"], fields }],
    };
    const applied = dsl.applyBindingPlan(cards, plan);
    return problemsOf(applied, [], dryRun(applied.tree, players, dsl, cards), plan as never, cards);
  };
  const name = { src: "I35:1;2", prop: "content", path: "name" };

  it("finds the photo the design varies across the cards", () => {
    expect(ownPictures(cards, ["35:1", "35:2", "35:3"])).toEqual([
      { srcs: ["I35:1;1", "I35:2;1", "I35:3;1"], alt: "PLAYER", distinct: 3 },
    ]);
  });

  it("reports the first card's photo drawn on every card", () => {
    expect(problems([name]).find((p) => p.startsWith("I35:1;1 picture"))).toContain(
      "draws 35:1's in every item of squad.players",
    );
  });

  it("finds nothing once the plan binds the photo, from a house fact's URL", () => {
    const photo = {
      src: "I35:1;1",
      prop: "src",
      template: "https://cdn.club/players/{p.id}.png",
    };
    expect(problems([name, photo]).some((p) => p.includes("picture"))).toBe(false);
  });

  it("reports the designer's photos left on cards bound by position", () => {
    const plan = {
      bind: [
        { src: "I35:1;2", prop: "content", path: "squad.players.0.name" },
        { src: "I35:2;2", prop: "content", path: "squad.players.1.name" },
      ],
    };
    const applied = dsl.applyBindingPlan(cards, plan);
    const found = problemsOf(
      applied,
      [],
      dryRun(applied.tree, players, dsl, cards),
      plan as never,
      cards,
    ).filter((p) => p.includes("bound by position"));
    // the third card shows no data, so its picture is the design's with the rest of it
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^I35:1;1, I35:2;1 still show/);
  });

  it("does not report a picture every card shares, such as a logo", () => {
    const same = {
      nodes: (
        cards as { nodes: Array<{ type: string; props: Record<string, unknown> }> }
      ).nodes.map((n) =>
        n.type === "Image" ? { ...n, props: { ...n.props, src: "data:image/png;base64,AAA" } } : n,
      ),
    } as never;
    expect(ownPictures(same, ["35:1", "35:2", "35:3"])).toEqual([]);
  });

  it("finds crests drawn as vectors, which compile to icons", () => {
    const crests = {
      nodes: (
        cards as { nodes: Array<{ id: string; type: string; props: Record<string, unknown> }> }
      ).nodes.map((n) =>
        n.type === "Image" ? { ...n, type: "Icon", props: { name: `crest-${n.id}` } } : n,
      ),
    } as never;
    expect(ownPictures(crests, ["35:1", "35:2", "35:3"])[0]?.distinct).toBe(3);
  });
});

describe("cards that differ by a badge", () => {
  // Figma instances: each card's layers are I<card>;<layer>. Card 1 and 2 have a captain's badge,
  // card 2 an overseas flag, card 3 neither; the photo and the name are on every card.
  const node = (
    id: string,
    parent: string | null,
    idx: number,
    type: string,
    src: string,
    props = {},
  ) => ({
    id,
    parent,
    idx,
    type,
    src,
    props,
  });
  const card = (n: number, badges: { captain?: boolean; flag?: boolean }) => [
    node(`card_${n}`, "row", n, "Overlay", `35:${n}`),
    node(`photo_${n}`, `card_${n}`, 0, "Image", `I35:${n};1`, {
      src: `data:image/png;base64,P${n}`,
      alt: "PLAYER",
    }),
    node(`name_${n}`, `card_${n}`, 1, "Text", `I35:${n};2`, { content: "Ben\nMcKinney" }),
    node(`badges_${n}`, `card_${n}`, 2, "Stack", `I35:${n};3`),
    ...(badges.captain
      ? [
          node(`captain_${n}`, `badges_${n}`, 0, "Stack", `I35:${n};4`),
          node(`c_${n}`, `captain_${n}`, 0, "Text", `I35:${n};4;5`, { content: "C" }),
        ]
      : []),
    ...(badges.flag
      ? [node(`flag_${n}`, `badges_${n}`, 1, "Image", `I35:${n};6`, { src: "data:x" })]
      : []),
  ];
  const tree = {
    nodes: [
      node("row", null, 0, "Stack", "35:0"),
      ...card(1, { captain: true }),
      ...card(2, { captain: true, flag: true }),
      ...card(3, {}),
    ],
  } as never;
  const members = ["35:1", "35:2", "35:3"];
  const players = asBag(
    {
      squad: {
        players: [
          { id: "1", first: "Glenn", last: "Maxwell", captain: true },
          { id: "2", first: "Obus", last: "Pienaar", captain: false },
        ],
      },
    },
    dsl,
  );
  const problems = (plan: Record<string, unknown>) => {
    const applied = dsl.applyBindingPlan(tree, plan);
    return problemsOf(applied, [], dryRun(applied.tree, players, dsl, tree), plan as never, tree);
  };
  const photo = { src: "I35:1;1", prop: "src", template: "https://cdn.club/p/{p.id}.png" };
  const collapse = (fields: unknown[]) => ({
    over: "squad.players",
    as: "p",
    members,
    shape: "varies",
    fields,
  });

  it("matches the cards by their layers, though one has a badge more", () => {
    expect(ownPictures(tree, members)[0]?.srcs).toEqual(["I35:1;1", "I35:2;1", "I35:3;1"]);
    expect(someOnly(tree, members).map((p) => [p.src, p.in.length, p.inTemplate])).toEqual([
      ["I35:1;4", 2, true],
      ["I35:2;6", 1, false],
    ]);
  });

  it("reports a badge the design shows on some cards that the plan draws on all, and one it drops", () => {
    const name = { src: "I35:1;2", prop: "content", template: "{p.first}\n{p.last}" };
    const found = problems({ collapse: [collapse([photo, name])] });
    expect(found.find((p) => p.startsWith("I35:1;4"))).toContain("draws it on every item");
    expect(found.find((p) => p.startsWith("I35:2;6"))).toContain("draws it on none");
  });

  it("is satisfied by a when on the badge", () => {
    const name = { src: "I35:1;2", prop: "content", template: "{p.first}\n{p.last}" };
    const found = problems({
      collapse: [collapse([photo, name])],
      set: [{ src: "I35:1;4", prop: "when", value: { path: "p.captain", eq: true } }],
    });
    expect(found.some((p) => p.startsWith("I35:1;4"))).toBe(false);
  });

  it("reports a name the design breaks over two lines drawn on one", () => {
    const name = { src: "I35:1;2", prop: "content", template: "{p.first} {p.last}" };
    expect(
      problems({ collapse: [collapse([photo, name])] }).find((p) => p.startsWith("I35:1;2")),
    ).toContain("on one line where the design breaks it");
  });
});

describe("the preview link", () => {
  it("names the project and the tree", () => {
    const p = previewOf(
      "http://localhost:3000/preview/default/05a86969-3145-45d0-95c4-1228e82be342?theme=t&surfaces=s",
    );
    expect([p.project, p.tree]).toEqual(["default", "05a86969-3145-45d0-95c4-1228e82be342"]);
    expect(() => previewOf("http://localhost:3000/preview/default/not-a-tree")).toThrow();
  });
});
