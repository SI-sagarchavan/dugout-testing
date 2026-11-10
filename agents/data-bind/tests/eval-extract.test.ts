import type { RunEvent } from "@dugout/contracts";
import { gradeData } from "@dugout/evals";
import { describe, expect, it } from "vitest";
import { boundFieldsOf, datedLists, outcomeOf, shownIn, variantsDrawn } from "../evals/extract.ts";

const tree = {
  nodes: [
    { src: "d", props: { content: "21 JULY" } },
    { src: "b", props: { content: "(100 Balls)" } },
  ],
};
const tried = (shows: string[]): RunEvent =>
  ({
    type: "tool.completed",
    data: { tool: "bind.try", ok: true, content: JSON.stringify({ shows }) },
  }) as never;

describe("reducing a run to what the data graders read", () => {
  it("reads what the last bind.try showed against the design's placeholders", () => {
    const events = [
      tried(['d content: "old"']),
      tried([
        'd content: "26 MAY", "5/26/2026"',
        'b content: "Overs"',
        'x content: "unknown node"',
      ]),
    ];
    expect(shownIn(events, tree)).toEqual([
      { node: "d", placeholder: "21 JULY", shown: ["26 MAY", "5/26/2026"] },
      { node: "b", placeholder: "(100 Balls)", shown: ["Overs"] },
    ]);
  });

  it("takes the leaf of every path and every field a template reads", () => {
    const plan = {
      bind: [{ src: "a", prop: "content", path: "squad.items.0.name" }],
      collapse: [
        {
          over: "day.matches",
          as: "match",
          fields: [
            { src: "b", prop: "content", path: "status_label" },
            { src: "c", prop: "content", template: '{match.teams.0.score | default:"–"}' },
          ],
          variants: [
            {
              src: "v",
              when: { path: "match.state", eq: "U" },
              fields: [{ src: "e", prop: "content", path: "start_time" }],
            },
          ],
        },
      ],
    };
    expect(boundFieldsOf(plan).sort()).toEqual(["name", "score", "start_time", "status_label"]);
  });

  it("counts a variant drawn only when some item has its state", () => {
    const plan = {
      collapse: [
        {
          over: "day.matches",
          as: "match",
          variants: [
            { src: "r", when: { path: "match.state", eq: "R" } },
            { src: "u", when: { path: "match.state", eq: "U" } },
          ],
        },
      ],
    };
    const days = (states: string[]) => ({ day: [{ matches: states.map((state) => ({ state })) }] });
    expect(variantsDrawn(plan, days(["R", "R"]))).toEqual(["R"]);
    expect(variantsDrawn(plan, days(["R", "U"])).sort()).toEqual(["R", "U"]);
  });

  it("grades a recorded run: the IPL squad bound as the Southern Brave's fails its entity check", () => {
    const outcome = outcomeOf({
      status: "completed",
      output: { data: "bound", remaining: [], sources: [{ hookId: "dugout_ipl_squad" }] },
      events: [tried(['d content: "Glenn Maxwell"'])],
      tree: { nodes: [{ src: "d", props: { content: "Player Name" } }] },
      plan: { bind: [{ src: "d", prop: "content", path: "players.0.name" }] },
      bag: { players: [{ name: "Glenn Maxwell", team: "Punjab Kings" }] },
      steps: 20,
      costUsd: 0.9,
    });
    const grades = Object.fromEntries(
      gradeData(
        { ending: "bound", must: { team: "Southern Brave" }, required: ["name"] },
        outcome,
      ).map((g) => [g.grader, g.pass]),
    );
    expect(grades).toMatchObject({ ending: true, "right-entity": false, coverage: true });
  });
});

describe("the dated lists of a plan (ticket 15)", () => {
  const timeOf = (v: unknown) =>
    typeof v === "string" && /^\d{4}-/.test(v) ? Date.parse(v) : undefined;
  const plan = {
    collapse: [
      {
        over: "news.items",
        as: "a",
        fields: [
          { prop: "content", path: "a.title" },
          { prop: "content", template: '{a.at | date:"d MMM"}' },
        ],
      },
    ],
  };

  it("reads the first bound field that is a time for most items, in the list's order", () => {
    const bag = {
      news: {
        items: [
          { title: "A", at: "2026-07-18" },
          { title: "B", at: "2026-07-10" },
        ],
      },
    };
    expect(datedLists(plan, bag, timeOf)).toEqual([
      { list: "news.items", times: [Date.parse("2026-07-18"), Date.parse("2026-07-10")] },
    ]);
  });

  it("leaves out a list with no time", () => {
    const bag = {
      news: {
        items: [
          { title: "A", at: "Round 2" },
          { title: "B", at: "Round 1" },
        ],
      },
    };
    expect(datedLists(plan, bag, timeOf)).toEqual([]);
  });
});
