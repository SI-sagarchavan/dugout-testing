import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { asBag, indexIr, loadDsl } from "../src/dsl.ts";
import {
  cardHolds,
  dateKey,
  datesInOrder,
  describeNames,
  draftNeed,
  dryRun,
  formOf,
  groups,
  hasForm,
  leftAsDesigned,
  namesIn,
  outline,
  ownPictures,
  pictureEvidence,
  rowsOf,
  sectionWords,
  shapeOf,
  someOnly,
  unboundCopy,
  varyingTexts,
} from "../src/facts.ts";
import { applyKeep, findingsOf, Plan, previewOf, problemsOf } from "../src/tools.ts";

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
  it("finds only the unit the data does not have in the reference plan, and draws every day and match", () => {
    expect(Plan.safeParse(reference).success).toBe(true);
    const { run, problems } = check(reference);
    // the hand-written plan binds overs where the design counts balls (ticket 14): nothing else
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes('where the design writes "(100 Balls)"'))).toBe(true);
    expect(problems[0]).toContain('shows "(20.0 Ov)" where the design writes "(100 Balls)"');
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

  it("reports a template no renderer reads, which the page would draw as written", () => {
    // run 1bdbed2b: the state label drew `{match.state | replace:…}` on every card, braces and all
    const plan = structuredClone(reference);
    const label = plan.collapse[0].fields.find(
      (f: { src: string }) => f.src === "I35:10546;18621:42503",
    );
    delete label.path;
    label.template = '{match.state | replace:"R":"RECENT","U":"UPCOMING"}';
    const { problems } = check(plan);
    expect(problems.some((p) => p.includes("not a ref the renderer reads"))).toBe(true);
  });

  it("reports a ref whose quoted argument holds braces, which the page draws as written", () => {
    // run 3b826dc5: `{g.cover_image | replace:"{{RATIO}}","1x1"}` drew on every card, and no check saw it
    const plan = structuredClone(reference);
    const label = plan.collapse[0].fields.find(
      (f: { src: string }) => f.src === "I35:10546;18621:42503",
    );
    delete label.path;
    label.template = '{match.state | replace:"{{RATIO}}","1x1"}';
    const { problems } = check(plan);
    expect(problems.some((p) => p.includes("not a ref the renderer reads"))).toBe(true);
  });

  it("reports a when that is no condition, which hides nothing", () => {
    // run 3b826dc5: `when: false` on the design's dummy cards, and the page drew them beside the data
    const plan = structuredClone(reference);
    plan.set.push({ src: "I35:10546;18621:42503", prop: "when", value: false });
    const { problems } = check(plan);
    expect(problems.some((p) => p.includes("when false: not a condition"))).toBe(true);
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

  it("reports data in lower case where the design writes capitals, as an observation a keep takes", () => {
    const plan = structuredClone(reference);
    plan.set = plan.set.filter(
      (s: { src: string; prop: string }) =>
        !(s.src === "I35:10546;18621:42503" && s.prop === "textCase"),
    );
    const applied = dsl.applyBindingPlan(tree, plan);
    const found = findingsOf(
      applied,
      [],
      dryRun(applied.tree, bag, dsl, tree, Date.parse("2026-11-15T12:17:27Z")),
      plan,
      tree,
    ).find((p) => p.src === "I35:10546;18621:42503");
    expect(found?.message).toContain(
      'I35:10546;18621:42503 shows "Recent" where the design writes capitals ("RECENT")',
    );
    // a design may write capitals as an example only: the binder decides, so a keep takes it
    expect(found?.keep).toBe(true);
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
    const found = problems.find((p) => p.startsWith("I35:10547;18621:42579"));
    expect(found).toContain('shows the design\'s "02" in all 2 items it draws in');
    // what was seen, not what it is: no recipe for one kind of design
    expect(found).not.toMatch(/clock|placeholder/);
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

  it("reports the row left showing the design beside the row that draws data, with its own ids", () => {
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
      },
    ]);
    const found = problems.find((p) => p.startsWith("35:10187 still shows"));
    expect(found).toContain(
      "beside 35:10184, its sibling of the same shape, which draws news.cards",
    );
    expect(found).toContain("Its own items: 35:10188, 35:10189");
    // the observation, not a computed fix
    expect(found).not.toMatch(/slice|\[0, 2\]/);
    // the first row draws all six cards in a row sized for two
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^news\.cards draws up to 6 items where the design drew 2, in 35:10184: a row/,
      ),
    );
  });

  it("does not report a row the plan hides with a when", () => {
    // run 75a770af: the design's last row, hidden where the feed has no item for it, was reported as
    // design copy, and the model kept it to answer a check that should not have fired
    const plan = read("agents/data-bind/tests/fixtures/news-grid.one-row.plan.json");
    plan.set = [
      ...(plan.set ?? []),
      { src: "35:10187", prop: "when", value: { path: "news.cards.9.id", exists: true } },
    ];
    const { left, problems } = checkGrid(plan);
    expect(left.map((l) => l.src)).not.toContain("35:10187");
    expect(problems.filter((p) => p.startsWith("35:10187 still shows"))).toEqual([]);
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
    expect(problems.filter((p) => p.includes("still shows the design's copy"))).toEqual([]);
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
      "every item of squad.players draws 35:1's",
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

  it("reports a picture each card has its own of with the evidence, and a keep with why takes it", () => {
    const plan = {
      bind: [
        { src: "I35:1;2", prop: "content", path: "squad.players.0.name" },
        { src: "I35:2;2", prop: "content", path: "squad.players.1.name" },
      ],
      keep: [{ src: "I35:1;1", why: "the feed has no photo" }],
    };
    const applied = dsl.applyBindingPlan(cards, plan);
    const evidence = pictureEvidence(players, [
      { key: "media.player-photo", content: "Player photos: https://cdn.club/players/{id}.png" },
    ]);
    const found = findingsOf(
      applied,
      [],
      dryRun(applied.tree, players, dsl, cards),
      plan as never,
      cards,
      [],
      [],
      [],
      evidence,
    ).filter((p) => p.message.includes("bound by position"));
    expect(found).toHaveLength(1);
    expect(found[0]?.keep).toBe(true);
    expect(found[0]?.message).toContain("House facts that build one: media.player-photo");
    expect(found[0]?.message).toContain("3 different ones");
    // no one site's URL scheme in what it says
    expect(found[0]?.message).not.toMatch(/ratio|static-assets|CMS/);
    // what the picture means is the binder's: a keep with why accepts it like any other
    const { open, kept } = applyKeep(found, cards, plan as never);
    expect(open).toEqual([]);
    expect(kept.join("\n")).toContain("accepts");
    // a settled field is not part of a keep any more
    const old = { ...plan, keep: [{ src: "I35:1;1", why: "decoration", settled: "no-picture" }] };
    expect(Plan.safeParse(old).success).toBe(false);
  });

  it("says the picture's box when the design fixed its size, and no ratio of its own", () => {
    const sized = {
      nodes: (
        cards as { nodes: Array<{ type: string; props: Record<string, unknown> }> }
      ).nodes.map((n) =>
        n.type === "Image" ? { ...n, props: { ...n.props, size: { w: 360, h: { raw: 640 } } } } : n,
      ),
    } as never;
    expect(ownPictures(sized, ["35:1", "35:2", "35:3"])[0]).toMatchObject({ box: "360 x 640 px" });
  });

  it("lets a plan keep a glyph each card has its own of with why: an icon is not a picture file", () => {
    const glyphs = {
      nodes: (
        cards as { nodes: Array<{ id: string; type: string; props: Record<string, unknown> }> }
      ).nodes.map((n) =>
        n.type === "Image" ? { ...n, type: "Icon", props: { name: `mark-${n.id}` } } : n,
      ),
    } as never;
    const plan = {
      collapse: [
        {
          over: "squad.players",
          as: "p",
          members: ["35:1", "35:2", "35:3"],
          fields: [{ src: "I35:1;2", prop: "content", path: "name" }],
        },
      ],
      keep: [{ src: "I35:1;1", why: "the mark is the designer's, the same meaning on every card" }],
    };
    const applied = dsl.applyBindingPlan(glyphs, plan);
    const found = findingsOf(
      applied,
      [],
      dryRun(applied.tree, players, dsl, glyphs),
      plan as never,
      glyphs,
    ).filter((p) => p.src === "I35:1;1");
    expect(found).toHaveLength(1);
    expect(found[0]?.keep).toBe(true);
    expect(applyKeep(found, glyphs, plan as never).open).toEqual([]);
  });

  it("gives the evidence a good question needs: the id field, real values, picture-shaped fields", () => {
    const sample = {
      squad: {
        players: [
          { id: 10085, name: "A", headshot: "/static/a.png" },
          { id: 4660, name: "B", headshot: "/static/b.png" },
        ],
      },
    };
    const text = pictureEvidence(sample);
    expect(text).toContain("The items carry id (e.g. 10085, 4660).");
    expect(text).toContain("Fields that look like picture URLs: headshot.");
    expect(text).toContain("No media.* house fact builds one.");
    expect(pictureEvidence({ x: [{ name: "a" }, { name: "b" }] })).toContain("carry no id field");
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

  it("reports a when that hides on most cards a part the design draws on every card", () => {
    const name = { src: "I35:1;2", prop: "content", template: "{p.first}\n{p.last}" };
    const gated = (value: unknown) =>
      problems({
        collapse: [collapse([photo, name])],
        set: [
          { src: "I35:1;4", prop: "when", value: { path: "p.captain", eq: true } },
          { src: "I35:1;3", prop: "when", value },
        ],
      }).find((p) => p.startsWith("I35:1;3"));
    expect(gated({ path: "p.captain", eq: true })).toContain(
      "on every one of the design's 3 items",
    );
    // hiding it where the item has nothing to show is not that
    expect(gated({ path: "p.first", exists: true })).toBeUndefined();
  });

  it("reports a text the design writes over two lines drawn on one, as an observation a keep takes", () => {
    const name = { src: "I35:1;2", prop: "content", template: "{p.first} {p.last}" };
    const plan = { collapse: [collapse([photo, name])] };
    const applied = dsl.applyBindingPlan(tree, plan);
    const found = findingsOf(
      applied,
      [],
      dryRun(applied.tree, players, dsl, tree),
      plan as never,
      tree,
    ).find((p) => p.src === "I35:1;2" && p.message.includes("on one line"));
    expect(found?.message).toContain('where the design writes it over 2 lines ("Ben\\nMcKinney")');
    expect(found?.keep).toBe(true);
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

describe("bind.try reports the design's format, the variants and what the data names (ticket 09)", () => {
  it("reports an ISO time where the design writes 19:30, and names the generic tools", () => {
    const plan = structuredClone(reference);
    const field = plan.collapse[0].fields.find((f: { path?: string }) => f.path === "local_time");
    field.path = "start_time";
    const { problems, run } = check(plan);
    expect(run.formats).toContainEqual(
      expect.objectContaining({ src: "I35:10546;18621:43142", design: "19:30" }),
    );
    const found = problems.find((p) => p.includes('where the design writes "19:30"'));
    expect(found).toContain("The date pipe writes a date or a time in the tokens you give it");
    expect(found).toContain("or keep it with why");
  });

  it("does not fault the reference plan's dash for a score an upcoming match lacks", () => {
    // only the two balls/overs texts: the dash a template falls back to is no form
    expect(check(reference).run.formats.map((f) => f.design)).toEqual([
      "(100 Balls)",
      "(100 Balls)",
    ]);
  });

  it("compares the words around a number: (20.0 Overs) is not (100 Balls), (98 Balls) is", () => {
    expect(formOf("(20.0 Overs)")).not.toBe(formOf("(100 Balls)"));
    expect(formOf("(98 Balls)")).toBe(formOf("(100 Balls)"));
    expect(formOf("21 JULY")).toBe(formOf("5 MARCH"));
    expect(formOf("166/5")).toBe(formOf("0/10"));
    expect(hasForm("(100 Balls)")).toBe(true);
    // design copy with no number is whatever the data says
    expect(hasForm("Batter")).toBe(false);
  });

  it("says what is drawn and what the design writes, and no fix of its own for any one form", () => {
    expect(dryRunFormats("21 JULY", "2026-07-21T19:30:00Z")).toEqual([
      { src: "t", design: "21 JULY", shows: "2026-07-21T19:30:00Z" },
    ]);
    expect(dryRunFormats("(100 Balls)", "Overs")).toEqual([
      { src: "t", design: "(100 Balls)", shows: "Overs" },
    ]);
  });

  it("compares forms case-folded", () => {
    // the node draws upper: "21 July" with textCase upper is the design's "21 JULY"
    expect(dryRunFormats("21 JULY", "21 July", { textCase: "upper" })).toEqual([]);
    // the design writes it in mixed case and the node shouts it: still the same form
    expect(dryRunFormats("21 July", "21 JULY")).toEqual([]);
    expect(dryRunFormats("2nd", "17")).toHaveLength(1);
  });

  /** A list whose items are drawn as a result card or an upcoming card, chosen by `m.state`. */
  const variantTree = () => {
    const node = (id: string, parent: string | null, type: string, props: object, idx = 0) => ({
      id,
      idx,
      parent,
      src: id,
      type,
      props,
    });
    return {
      schemaVersion: "1",
      nodes: [
        node("root", null, "Stack", {}),
        node("rep", "root", "Repeater", { over: "list.items", as: "m" }),
        node("res", "rep", "Stack", { when: { path: "m.state", eq: "R" } }, 0),
        node("res-t", "res", "Text", { content: "{m.title}" }),
        node("up", "rep", "Stack", { when: { path: "m.state", eq: "U" } }, 1),
        node("up-t", "up", "Text", { content: "{m.start}" }),
      ],
    } as never;
  };

  it("reports a variant no item draws, and draws it once on an item made for it", () => {
    const data = {
      list: {
        items: [
          { state: "R", title: "A beat B" },
          { state: "R", title: "C beat D" },
        ],
      },
    };
    const run = dryRun(variantTree(), data, dsl);
    expect(run.unseen).toEqual([
      {
        template: "res",
        src: "up",
        when: '{"path":"m.state","eq":"U"}',
        made: true,
        missing: ["m.start"],
      },
    ]);
    // the made item copies a result item, so a field only an upcoming item has reads nothing:
    // reported with the variant as unseen, never as a hole a person would see (review of 09)
    expect(run.unresolved).toEqual([]);
    // and what the made item shows is not what the sample shows
    expect(run.samples.flatMap((s) => s.values)).not.toContain("");
    const found = findingsOf({ drift: [], tree: variantTree() }, [], run).map((p) => p.message);
    expect(found.some((m) => m.includes("no item of the sample draws up"))).toBe(true);
    expect(found.some((m) => m.includes("its refs were checked"))).toBe(true);
    expect(found.some((m) => m.includes("m.start read nothing"))).toBe(true);
    // a keep takes it: the sample has no such item
    expect(found.some((m) => m.includes("has nothing at m.start"))).toBe(false);
  });

  it("says so, and does not make an item, for a variant a clock or a page choice decides", () => {
    const tree = variantTree();
    const up = (tree as { nodes: Array<{ id: string; props: object }> }).nodes.find(
      (n) => n.id === "up",
    );
    if (up) up.props = { when: { path: "countdown.past", eq: false } };
    const data = { list: { items: [{ state: "R", title: "A beat B" }] } };
    expect(dryRun(tree, data, dsl).unseen).toEqual([
      { template: "res", src: "up", when: '{"path":"countdown.past","eq":false}', made: false },
    ]);
  });

  it("draws nothing extra when every variant is drawn", () => {
    const data = {
      list: {
        items: [
          { state: "R", title: "A beat B" },
          { state: "U", start: "19:30" },
        ],
      },
    };
    expect(dryRun(variantTree(), data, dsl).unseen).toEqual([]);
  });

  it("says what the data's items name, most often first, and judges nothing", () => {
    const other = {
      players: [
        { name: "a", team: "Northern Lights" },
        { name: "b", team: "Northern Lights" },
        { name: "c", team: { name: "Eastern Tide" } },
      ],
    };
    expect(namesIn(other)).toEqual([
      {
        list: "players",
        kind: "team",
        fields: ["team", "team.name"],
        names: [
          { name: "Northern Lights", items: 2 },
          { name: "Eastern Tide", items: 1 },
        ],
        of: 3,
      },
    ]);
    expect(describeNames(namesIn(other))).toEqual([
      'players: its 3 item(s) name the team "Northern Lights" (2), "Eastern Tide" in team, team.name',
    ]);
    // a competition, by a field that names one
    const events = { events: [{ title: "Final", league: "Coastal Cup" }] };
    expect(namesIn(events)).toMatchObject([
      { kind: "competition", names: [{ name: "Coastal Cup" }] },
    ]);
  });

  it("lists nothing for items that have no field naming a team: news, a squad's players", () => {
    const news = {
      items: [
        { title: "New kit revealed", published: "2026-07-01" },
        { title: "Season tickets on sale", published: "2026-06-28" },
      ],
    };
    expect(namesIn(news)).toEqual([]);
    expect(namesIn({ women: [{ name: "A Player", role: "Batter" }] })).toEqual([]);
  });
});

/** The formats `dryRun` finds for one text node bound straight to a value. */
function dryRunFormats(design: string, value: string, props: object = {}) {
  const node = (id: string, parent: string | null, type: string, props: object) => ({
    id,
    idx: 0,
    parent,
    src: id,
    type,
    props,
  });
  const make = (content: string) =>
    ({
      schemaVersion: "1",
      nodes: [node("root", null, "Stack", {}), node("t", "root", "Text", { content, ...props })],
    }) as never;
  return dryRun(make("{v}"), { v: value }, dsl, make(design)).formats;
}

describe("the pictures a dry run asks for", () => {
  const node = (id: string, parent: string | null, type: string, props: object) => ({
    id,
    idx: 0,
    parent,
    src: id,
    type,
    props,
  });
  const cdn = "https://cdn.example/static-assets/media/{{RATIO}}-a.jpg";
  const urls = (props: object) =>
    dryRun(
      {
        schemaVersion: "1",
        nodes: [
          node("root", null, "Stack", {}),
          node("i", "root", "Image", { src: "{v}", ...props }),
        ],
      } as never,
      { v: cdn },
      dsl,
    ).pictures[0]?.urls;

  it("fills the CDN's ratio slot from the Image's ratio, as the renderer does", () => {
    // run 3b826dc5: the slot left in answered a 68-byte stand-in, reported as a picture that draws nothing
    expect(urls({ ratio: "1/1" })).toEqual(["https://cdn.example/static-assets/media/1-1-a.jpg"]);
    expect(urls({})).toEqual(["https://cdn.example/static-assets/media/0-a.jpg"]);
  });
});

describe("the need, drafted by code from the design (ticket 08)", () => {
  it("gives an inner repeat's fields to the inner list only", () => {
    const n = (id: string, parent: string | null, type: string, idx: number, content?: string) => ({
      id,
      idx,
      parent,
      src: id,
      type,
      props: content === undefined ? {} : { content },
    });
    // a day card ("21 JULY") with two event panels, each a title and a time
    const panel = (card: string, i: number) => [
      n(`${card}-p${i}`, `${card}-panels`, "Stack", i),
      n(`${card}-p${i}-t`, `${card}-p${i}`, "Text", 0, "Open session"),
      n(`${card}-p${i}-h`, `${card}-p${i}`, "Text", 1, "19:30"),
    ];
    const card = (id: string, idx: number) => [
      n(id, "root", "Stack", idx),
      n(`${id}-d`, id, "Text", 0, "21 JULY"),
      n(`${id}-panels`, id, "Stack", 1),
      ...panel(id, 0),
      ...panel(id, 1),
    ];
    const tree = {
      schemaVersion: "1",
      nodes: [n("root", null, "Stack", 0), ...card("c1", 0), ...card("c2", 1)],
    } as never;
    const all = groups(tree, new Map());
    const days = all.find((g) => g.parent === "root");
    const panels = all.find((g) => g.parent === "c1-panels");
    if (!days || !panels) throw new Error("no lists");
    expect(draftNeed(tree, days, all)?.item.map((f) => f.example)).toEqual(["21 JULY"]);
    expect(draftNeed(tree, panels, all)?.item.map((f) => f.example)).toEqual([
      "Open session",
      "19:30",
    ]);
  });

  it("counts the cards a list draws and lists what the first one shows, as drawn, with no kind", () => {
    const found = groups(tree, byId);
    // the match panels of a day card: a list in a card, not on a rail
    const day = found.find((g) => g.parent === "I35:10546;18621:42500");
    if (!day) throw new Error("no group");
    const need = draftNeed(tree, day);
    expect(need?.count).toBe(day.members.length);
    // what kind of value "19:30" is, is the model's to say
    expect(need?.item.find((f) => f.example === "19:30")).toEqual({
      node: expect.any(String),
      drawnAs: "text",
      example: "19:30",
      // the other cards' text at that place: evidence, read by the model
      othersShow: ["19:30", "22:30"],
    });
    expect(need?.item.every((f) => f.node.length > 0 && !("kind" in f))).toBe(true);
  });

  it("asks for whatever the data holds for the cards of a carousel: those drawn are what fits on view", () => {
    // run 5c5da766: the squad rail asked for 5 players, the 5 the design draws; a looping rail of
    // five that bleeds past its box left the right side empty
    const days = groups(tree, byId).find((g) => g.parent === "35:10545");
    if (!days) throw new Error("no group");
    expect(draftNeed(tree, days)?.count).toBe("data");
  });
});

describe("a Repeater that follows a page choice, drawn against the sample (ticket 13)", () => {
  const node = (id: string, parent: string | null, type: string, props: object, idx = 0) => ({
    id,
    idx,
    parent,
    src: id,
    type,
    props,
  });
  const tree = (over: string) =>
    ({
      schemaVersion: "1",
      nodes: [
        node("root", null, "Stack", {}),
        node("t1", "root", "Stack", { select: { key: "view", value: "results" } }, 0),
        node("t2", "root", "Stack", { select: { key: "view", value: "upcoming" } }, 1),
        node("rep", "root", "Repeater", { over, as: "row" }, 2),
        node("txt", "rep", "Text", { content: "{row.name}" }),
      ],
    }) as never;

  it("draws the list of each option the data has, and draws nothing extra for one it lacks", () => {
    const both = { table: { results: [{ name: "A" }], upcoming: [{ name: "B" }, { name: "C" }] } };
    const run = dryRun(tree("table.{_page.view}"), both, dsl);
    // one template drawn for both lists: its items add up
    expect(run.repeats).toEqual([expect.objectContaining({ template: "txt", items: 3, most: 2 })]);
    expect(run.unresolved).toEqual([]);
    // an option naming no list draws every list (the DSL's ALL rule): not a hole
    const half = dryRun(tree("table.{_page.view}"), { table: { results: [{ name: "A" }] } }, dsl);
    expect(half.unresolved).toEqual([]);
    expect(half.repeats).toEqual([expect.objectContaining({ template: "txt", items: 1 })]);
    // a key with a dot in it is one option, not a path
    const seasons = dryRun(
      tree("table.{_page.view}"),
      { table: { "2025.26": [{ name: "A" }], "2024.25": [{ name: "B" }] } },
      dsl,
    );
    expect(seasons.unresolved).toEqual([]);
    expect(seasons.repeats).toEqual([expect.objectContaining({ items: 2 })]);
    // no list there at all is a hole
    const none = dryRun(tree("table.{_page.view}"), { table: {} }, dsl);
    expect(none.unresolved.map((u) => u.prop)).toContain("over");
  });
});

describe("texts the design's cards write differently at one place (ticket 14)", () => {
  const n = (id: string, parent: string | null, type: string, props: object, idx = 0) => ({
    id,
    idx,
    parent,
    src: id,
    type,
    props,
  });
  /** Two player cards: a batter's says Runs, a bowler's says Wickets, above a figure. */
  const cards = () =>
    ({
      schemaVersion: "1",
      nodes: [
        n("root", null, "Stack", {}),
        n("c1", "root", "Stack", {}, 0),
        n("c1-name", "c1", "Text", { content: "Player Name" }, 0),
        n("c1-label", "c1", "Text", { content: "Runs" }, 1),
        n("c1-value", "c1", "Text", { content: "412" }, 2),
        n("c2", "root", "Stack", {}, 1),
        n("c2-name", "c2", "Text", { content: "Player Name" }, 0),
        n("c2-label", "c2", "Text", { content: "Wickets" }, 1),
        n("c2-value", "c2", "Text", { content: "17" }, 2),
      ],
    }) as never;

  it("finds every text that differs across cards, whatever it is: what it means is the binder's", () => {
    expect(varyingTexts(cards(), ["c1", "c2"])).toEqual([
      { src: "c1-label", texts: ["Runs", "Wickets"] },
      { src: "c1-value", texts: ["412", "17"] },
    ]);
  });

  it("puts what the other cards show on the need, and reports a plan that leaves one card's", () => {
    const need = draftNeed(cards(), { members: ["c1", "c2"] });
    expect(need?.item.find((f) => f.node === "c1-label")?.othersShow).toEqual(["Runs", "Wickets"]);
    expect(need?.item.find((f) => f.node === "c1-name")?.othersShow).toBeUndefined();
    const plan = {
      collapse: [
        {
          over: "p.items",
          as: "p",
          members: ["c1", "c2"],
          fields: [{ src: "c1-name", prop: "content", path: "name" }],
        },
      ],
    };
    const found = findingsOf(
      { drift: [], tree: cards() },
      [],
      dryRun(cards(), { p: { items: [{ name: "a" }] } }, dsl),
      plan as never,
      cards(),
    ).map((p) => p.message);
    const label = found.find((m) => m.startsWith("c1-label"));
    expect(label).toContain('the design\'s cards write it differently: "Runs", "Wickets"');
    expect(label).not.toMatch(/stats|batter|bowler/i);
    // bound from the item, it is no problem
    const bound = {
      collapse: [
        {
          ...plan.collapse[0],
          fields: [
            ...(plan.collapse[0]?.fields ?? []),
            { src: "c1-label", prop: "content", path: "label" },
          ],
        },
      ],
    };
    const again = findingsOf(
      { drift: [], tree: cards() },
      [],
      dryRun(cards(), { p: { items: [{ name: "a", label: "Runs" }] } }, dsl),
      bound as never,
      cards(),
    ).map((p) => p.message);
    expect(again.some((m) => m.startsWith("c1-label"))).toBe(false);
  });
});

describe("which items, in what order, grouped how (ticket 15)", () => {
  it("gives a list's own words, not another list's or the cards' words", () => {
    const n = (id: string, parent: string | null, type: string, idx: number, content?: string) => ({
      id,
      idx,
      parent,
      src: id,
      type,
      props: content === undefined ? {} : { content },
    });
    // two lists in one frame: LATEST NEWS over articles, UPCOMING EVENTS over events
    const tree = {
      schemaVersion: "1",
      nodes: [
        n("root", null, "Stack", 0),
        n("news", "root", "Stack", 0),
        n("news-h", "news", "Text", 0, "LATEST NEWS"),
        n("news-list", "news", "Stack", 1),
        n("a1", "news-list", "Stack", 0),
        n("a1t", "a1", "Text", 0, "Next match preview"),
        n("a2", "news-list", "Stack", 1),
        n("a2t", "a2", "Text", 0, "Next match preview"),
        n("events", "root", "Stack", 1),
        n("events-h", "events", "Text", 0, "UPCOMING EVENTS"),
        n("events-list", "events", "Stack", 1),
        n("e1", "events-list", "Stack", 0),
        n("e1t", "e1", "Text", 0, "Fan day"),
        n("e2", "events-list", "Stack", 1),
        n("e2t", "e2", "Text", 0, "Fan day"),
        n("events-more", "events", "Text", 2, "VIEW ALL"),
      ],
    } as never;
    const all = groups(tree, new Map());
    const news = all.find((g) => g.parent === "news-list");
    const events = all.find((g) => g.parent === "events-list");
    if (!news || !events) throw new Error("no lists");
    expect(sectionWords(tree, news, all)).toEqual(["LATEST NEWS"]);
    expect(sectionWords(tree, events, all)).toEqual(["UPCOMING EVENTS", "VIEW ALL"]);
  });

  it("says how a list's dates run, from the dates the plan binds, and judges no order", () => {
    const now = Date.parse("2026-07-20T12:00:00Z");
    const keyOf = dateKey(dsl.readDate);
    // a pipe on the path, and the field named in a template: both read the item's own date
    const plan = {
      collapse: [
        {
          over: "news.items",
          as: "n",
          fields: [{ path: "title" }, { path: 'published | date:"DD MMM"' }],
        },
      ],
    };
    const items = (...dates: string[]) => ({
      news: { items: dates.map((published, i) => ({ title: `t${i}`, published })) },
    });
    expect(datesInOrder(plan, items("2026-07-18", "2026-07-10"), keyOf, now)).toEqual([
      {
        over: "news.items",
        path: "published",
        values: ["2026-07-18", "2026-07-10"],
        run: "latest first",
        past: 2,
        of: 2,
      },
    ]);
    expect(datesInOrder(plan, items("2026-07-10", "2026-07-22"), keyOf, now)[0]).toMatchObject({
      run: "earliest first",
      past: 1,
    });
    expect(
      datesInOrder(plan, items("2026-07-25", "2026-07-10", "2026-07-22"), keyOf, now)[0]?.run,
    ).toBe("neither");
    const template = {
      collapse: [
        {
          over: "f.items",
          as: "m",
          fields: [{ src: "x", prop: "content", template: '{m.kickoff | date:"HH:mm"} {m.venue}' }],
        },
      ],
    };
    const kickoffs = {
      f: { items: [{ kickoff: "2026-07-22T19:00:00Z" }, { kickoff: "2026-07-21T19:00:00Z" }] },
    };
    expect(datesInOrder(template, kickoffs, keyOf, now)[0]?.path).toBe("kickoff");
    // a field the page does not read as a date (a round, an id) is not what a list runs by
    const rounds = { f: { items: [{ kickoff: "Round 3" }, { kickoff: "Round 1" }] } };
    expect(datesInOrder(template, rounds, keyOf, now)).toEqual([]);
    const ids = { f: { items: [{ kickoff: "1234567890" }, { kickoff: "1234567891" }] } };
    expect(datesInOrder(template, ids, keyOf, now)).toEqual([]);
  });

  it("says a card holds several items of one shape (a day's matches in one card)", () => {
    const n = (id: string, parent: string | null, type: string, idx = 0) => ({
      id,
      idx,
      parent,
      src: id,
      type,
      props: type === "Text" ? { content: id } : {},
    });
    const tree = {
      schemaVersion: "1",
      nodes: [
        n("root", null, "Stack"),
        n("c1", "root", "Stack", 0),
        n("m1", "c1", "Stack", 0),
        n("m1t", "m1", "Text"),
        n("m2", "c1", "Stack", 1),
        n("m2t", "m2", "Text"),
        n("c2", "root", "Stack", 1),
        n("m3", "c2", "Stack", 0),
        n("m3t", "m3", "Text"),
        n("m4", "c2", "Stack", 1),
        n("m4t", "m4", "Text"),
      ],
    } as never;
    const found = groups(tree, new Map());
    const outer = found.find((g) => g.parent === "root");
    if (!outer) throw new Error("no outer group");
    expect(cardHolds(tree, found, outer)).toBe(2);
  });
});

describe("a carousel that draws one slide", () => {
  const n = (id: string, parent: string | null, type: string, idx: number, props: object = {}) => ({
    id,
    idx,
    parent,
    src: id,
    type,
    props,
  });
  const tree = {
    schemaVersion: "1",
    nodes: [
      n("hero", null, "Overlay", 0),
      n("c", "hero", "Carousel", 0, { slidesPerView: 1 }),
      n("slide", "c", "Overlay", 0),
      n("photo", "slide", "Image", 0, { src: "a.png" }),
      n("title", "slide", "Text", 1, { content: "TOPLEY AND OVERTON STEPPED UP" }),
      n("date", "slide", "Text", 2, { content: "09 Jul, 2025" }),
    ],
  } as never;

  it("is a list of one, repeated for whatever the data holds", () => {
    const all = groups(tree, new Map());
    expect(all).toEqual([{ parent: "c", members: ["slide"], shapes: [["slide"]], oneSlide: true }]);
    const [slide] = all;
    if (!slide) throw new Error("no list");
    const need = draftNeed(tree, slide, all);
    expect(need?.count).toBe("data");
    expect(need?.item.map((f) => [f.drawnAs, f.example])).toEqual([
      ["picture", ""],
      ["text", "TOPLEY AND OVERTON STEPPED UP"],
      ["text", "09 Jul, 2025"],
    ]);
  });
});
