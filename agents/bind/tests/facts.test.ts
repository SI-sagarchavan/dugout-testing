import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { asBag, indexIr, loadDsl } from "../src/dsl.ts";
import { dryRun, groups, outline, shapeOf } from "../src/facts.ts";
import { Plan, previewOf, problemsOf } from "../src/tools.ts";

/**
 * The fixtures strip: the tree card-match published, its Figma IR, the dummy Cast response, and the
 * plan written by hand for it, which is the answer the agent is checked against.
 */
const read = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
const tree = read("agents/bind/tests/fixtures/fixtures-strip.tree.json");
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
    problems: problemsOf(applied, dsl.check(applied.tree), run, plan as never, tree),
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
      { template: "35:10546", over: "fixtures.items", items: 7 },
      { template: "I35:10546;18621:42501", over: "day.matches", items: 9 },
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

describe("the preview link", () => {
  it("names the project and the tree", () => {
    const p = previewOf(
      "http://localhost:3000/preview/default/05a86969-3145-45d0-95c4-1228e82be342?theme=t&surfaces=s",
    );
    expect([p.project, p.tree]).toEqual(["default", "05a86969-3145-45d0-95c4-1228e82be342"]);
    expect(() => previewOf("http://localhost:3000/preview/default/not-a-tree")).toThrow();
  });
});
