/**
 * SELECT PLAYERS (Southern Brave's fan preferences): the design's cards show a tick or an empty
 * circle, a filled or an outline star, a name in bold blue or plain, a search box over the list and a
 * list longer than its sheet. The behaviours a model settles from that evidence, compiled and checked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";
import { beforeAll, describe, expect, it } from "vitest";
import { type CheckDsl, check } from "../src/check.ts";
import { type Behaviours, compile } from "../src/compile.ts";
import { evidenceOf } from "../src/evidence.ts";

const fixture = (f: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `fixtures/select-players.${f}.json`), "utf8"));
const tree = fixture("tree");
const plan = fixture("plan");
const data = fixture("data");
const ir = fixture("ir");

let dsl: CheckDsl;
beforeAll(async () => {
  dsl = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
  )) as CheckDsl;
});

const TICK = "I551:13364;19645:16258";
const CIRCLE = "I551:13365;19645:16081";
const STAR = "I551:13364;19645:16079";
const FILLED = "I551:13366;19645:17062";
const NAME = "I551:13364;19645:16074";
const BOLD_BLUE = "I551:13367;19645:16074";
const PLAIN = "I551:13365;19645:16074";
/** The card's captain badge: the binding plan draws it only when `p.is_captain`. */
const CAPTAIN = "I551:13364;19645:16075";

const behaviours: Behaviours = {
  toggles: [
    {
      list: "picked",
      over: "squad.players",
      key: "id",
      press: ["551:13364"],
      max: 0,
      share: true,
      keep: "page",
    },
    {
      list: "favourite",
      over: "squad.players",
      key: "id",
      press: [STAR, FILLED],
      max: 2,
      share: true,
      keep: "page",
    },
  ],
  show: [
    { src: TICK, when: { lists: ["picked"], is: "in" } },
    { src: CIRCLE, when: { lists: ["picked"], is: "out" } },
    { src: STAR, when: { lists: ["favourite"], is: "out" } },
    { src: FILLED, when: { lists: ["favourite"], is: "in" } },
  ],
  restyle: [{ src: NAME, look: BOLD_BLUE, when: { lists: ["picked", "favourite"], is: "in" } }],
  search: [{ field: "search", over: "squad.players", path: "name" }],
  scroll: [{ src: "551:13362", axis: "y" }],
  // the stars and ticks sit in the badge the plan drew for captains only: the model settles that
  // the fan's picks decide them now
  planRules: [{ src: CAPTAIN, prop: "when", decide: "state" }],
};

describe("the evidence", () => {
  it("names the parts that differ by card, the search box and the list longer than its sheet", () => {
    const e = evidenceOf(tree, plan, data, ir);
    const list = e.lists[0];
    // a proposal, with every field that would do
    expect(list?.key).toBe("id");
    expect(list?.keys).toContain("id");
    const differ = new Map(list?.differences.map((d) => [d.template, d]));
    expect(differ.get(TICK)?.groups.map((g) => g.cards)).toContainEqual([1, 4]);
    expect(differ.get(STAR)?.groups.find((g) => g.srcs.includes(FILLED))?.cards).toEqual([3]);
    expect(differ.get(NAME)?.groups.find((g) => g.srcs.includes(PLAIN))?.cards).toEqual([
      2, 5, 6, 7, 8,
    ]);
    // a photo each card has its own of is reported, with what the plan binds there: not dropped
    const photo = list?.differences.find((d) => d.boundTo?.includes("src <- photo"));
    expect(photo?.everyCard).toMatch(/each of the 8 cards/);
    // what the binding plan already decides about the card's layers
    expect(list?.planRules).toContainEqual({
      src: CAPTAIN,
      prop: "when",
      value: { eq: true, path: "p.is_captain" },
    });
    expect(e.fields).toEqual([
      { key: "search", type: "Input", src: "551:13350", placeholder: "Search Players" },
    ]);
    expect(e.overflow).toEqual([
      { src: "551:13362", node: "stack_9", axis: "y", box: 411, content: 572 },
    ]);
  });
});

describe("compiled", () => {
  const out = compile(tree, plan, behaviours);

  it("writes the machine, the presses and the search, with no ref in the tree", () => {
    expect(out.problems).toEqual([]);
    const root = out.tree.nodes.find((n) => n.parent === null);
    const machine = root?.props.machine as Record<string, Record<string, unknown>>;
    expect(machine.context).toEqual({ picked: [], favourite: [] });
    expect(Object.keys(machine.on ?? {})).toEqual(["picked.toggle", "favourite.toggle"]);
    expect(machine.computed?.favourite_or_picked).toBeDefined();
    expect(machine.exports).toEqual({
      picked: { var: "context.picked" },
      favourite: { var: "context.favourite" },
    });
    expect(out.plan.set).toContainEqual({
      src: "551:13364",
      prop: "on",
      value: { click: { send: "picked.toggle", payload: { id: "{p.id}" } } },
    });
    expect(out.plan.collapse?.[0]?.when).toContainEqual({
      path: "p.name",
      containsPath: "_page.search",
    });
    expect(out.tree.nodes.find((n) => n.src === "551:13362")?.props.scroll).toBe("y");
    // the captain gate the plan had on the star and tick is the state's now, as the model decided
    expect(out.plan.set?.some((s) => s.prop === "when")).toBe(false);
    expect(out.conflicts).toContainEqual(
      expect.objectContaining({ src: CAPTAIN, prop: "when", decided: "state" }),
    );
    expect(out.notes.join("\n")).toMatch(/took off the plan's when on/);
  });

  it("draws one look of each part in every state of an item", () => {
    const checked = check(out, behaviours, data, dsl);
    expect(checked.problems).toEqual([]);
    expect(checked.states).toHaveLength(4);
    const state = (label: string) => checked.states.find((s) => s.startsWith(`${label}:`)) ?? "";
    expect(state("not picked, not favourite")).toMatch(/ben_mckinney\b/);
    expect(state("not picked, not favourite")).not.toMatch(/ben_mckinney_state/);
    expect(state("picked, not favourite")).toMatch(/ben_mckinney_state/);
    expect(state("picked, not favourite")).toMatch(/icon_2\b/);
    expect(state("not picked, favourite")).toMatch(/icon_4_ix/);
  });

  it("reports a plan rule on a part the state now decides, and takes nothing off by itself", () => {
    const { planRules: _, ...undecided } = behaviours;
    const open = compile(tree, plan, undecided);
    expect(open.conflicts).toEqual([
      expect.objectContaining({
        src: CAPTAIN,
        prop: "when",
        value: { eq: true, path: "p.is_captain" },
      }),
    ]);
    expect(open.problems.join("\n")).toMatch(/say in planRules whether the state decides alone/);
    expect(open.plan.set).toContainEqual({
      src: CAPTAIN,
      prop: "when",
      value: { eq: true, path: "p.is_captain" },
    });
  });

  it("keeps the plan's when beside the state's when the model says both hold", () => {
    const both: Behaviours = {
      ...behaviours,
      planRules: [{ src: CAPTAIN, prop: "when", decide: "both" }],
    };
    const kept = compile(tree, plan, both);
    expect(kept.problems).toEqual([]);
    expect(kept.plan.set).toContainEqual({
      src: CAPTAIN,
      prop: "when",
      value: { eq: true, path: "p.is_captain" },
    });
    // and the check says what that draws: the first player is no captain, so no star or tick
    expect(check(kept, both, data, dsl).problems.join("\n")).toMatch(/is drawn in no state/);
  });

  it("reports what it cannot do instead of guessing", () => {
    const wrong = compile(tree, plan, {
      ...behaviours,
      show: [{ src: "nope", when: { lists: ["picked"], is: "in" } }],
      search: [{ field: "query", over: "squad.players", path: "name" }],
      scroll: [{ src: "551:13350", axis: "y" }],
    });
    expect(wrong.problems.join("\n")).toMatch(/nope is not a layer/);
    expect(wrong.problems.join("\n")).toMatch(/no field writes query/);
    expect(wrong.problems.join("\n")).toMatch(/only a Stack scrolls/);
  });
});
