import { describe, expect, it } from "vitest";
import {
  countEvidence,
  fieldEvidence,
  filterEvidence,
  fitIssues,
  isKind,
  orderEvidence,
  orderIssues,
  parseCover,
  valuesAt,
} from "../src/fit.ts";

const output = {
  days: [
    {
      date: "2026-07-21",
      matches: [
        { state: "R", teams: [{ logo: "https://cdn/a.png", score: "166/5" }], venue: "" },
        { state: "U", teams: [{ logo: "/img/b.png", score: null }], venue: null },
      ],
    },
  ],
};

describe("paths from the root of a hook's output", () => {
  it("goes through lists with [], by index, and with dots", () => {
    expect(valuesAt(output, "days[].matches[].state")).toEqual(["R", "U"]);
    expect(valuesAt(output, "days[0].matches[1].teams[0].logo")).toEqual(["/img/b.png"]);
    expect(valuesAt(output, "days.0.matches.0.teams.0.score")).toEqual(["166/5"]);
    expect(valuesAt(output, "days[].nothing")).toEqual([]);
    expect(valuesAt({ list: [{ a: 1 }, { a: 2 }] }, "list.a")).toEqual([1, 2]);
  });

  it("reads a cover line as a label and a path, ignoring a note after it", () => {
    expect(parseCover("match state → days[].matches[].state (R, U, L)")).toEqual({
      label: "match state",
      path: "days[].matches[].state",
    });
    expect(parseCover("no arrow here")).toBeUndefined();
  });
});

describe("the kind of value the design draws", () => {
  it("accepts a picture URL or path, a score with figures, a date, a time and a number", () => {
    expect(isKind("image", "https://cdn/a.png")).toBe(true);
    expect(isKind("image", "Southern Brave")).toBe(false);
    expect(isKind("score", "166/5")).toBe(true);
    expect(isKind("score", "won")).toBe(false);
    expect(isKind("date", "2026-07-21T19:30:00Z")).toBe(true);
    expect(isKind("time", "19:30")).toBe(true);
    expect(isKind("time", "tomorrow")).toBe(false);
    expect(isKind("number", "42")).toBe(true);
    expect(isKind("number", "n/a")).toBe(false);
  });
});

describe("an answer against the output a run really gave", () => {
  const items = [
    { field: "team crest", required: true, kind: "image" as const },
    { field: "score", required: true, kind: "score" as const },
    { field: "venue", required: false },
    { field: "tickets link", required: false },
  ];

  it("passes an answer whose paths hold what the design draws", () => {
    expect(
      fitIssues(
        items,
        {
          covers: [
            "team crest → days[].matches[].teams[0].logo",
            "score → days[].matches[].teams[0].score",
          ],
          missing: ["tickets link: no connector has it"],
        },
        output,
      ),
    ).toEqual([]);
  });

  it("faults a path empty for every item: it is missing, not covered", () => {
    const issues = fitIssues(
      items,
      { covers: ["venue → days[].matches[].venue"], missing: [] },
      output,
    );
    expect(issues.join("\n")).toContain("nothing there for any item");
  });

  it("faults a required item the answer does not account for", () => {
    const issues = fitIssues(items, { covers: [], missing: [] }, output);
    expect(issues[0]).toContain(
      '"team crest" is required by the need and is in neither covers nor missing: name it as the need writes it',
    );
    expect(issues).toHaveLength(2);
  });

  it("matches a field by its words as the need writes them, never by a guess", () => {
    const said = (covers: string[], missing: string[]) =>
      fitIssues([{ field: "team crest", required: true }], { covers, missing }, output);
    expect(said(["Team Crest → days[].matches[].teams[0].logo"], [])).toEqual([]);
    expect(said([], ["team crest: the feed has no picture"])).toEqual([]);
    // a line that only mentions it, or a label that holds it among other words, is not it
    expect(said(["crest → days[].matches[].teams[0].logo"], [])).toHaveLength(1);
    expect(said([], ["no team crest in the feed"])).toHaveLength(1);
  });

  it("faults a path that holds no value of the field's kind, such as names where a picture is drawn", () => {
    const wrong = { rows: [{ crest: "Southern Brave" }, { crest: "Brave" }] };
    const issues = fitIssues(
      [{ field: "team crest", required: true, kind: "image" }],
      { covers: ["team crest → rows[].crest"], missing: [] },
      wrong,
    );
    expect(issues[0]).toContain(
      'holds no image (the need\'s kind for it): its values are "Southern Brave", "Brave"',
    );
    // some of the kind: the model judges the rest from the evidence
    expect(
      fitIssues(
        [{ field: "team crest", required: true, kind: "image" }],
        { covers: ["team crest → rows[].crest"], missing: [] },
        { rows: [{ crest: "https://cdn/a.png" }, { crest: "TBC" }] },
      ),
    ).toEqual([]);
  });

  it("does not fault a field some items lack", () => {
    expect(
      fitIssues(
        [{ field: "score", required: false }],
        { covers: ["score → days[].matches[].teams[0].score"], missing: [] },
        output,
      ),
    ).toEqual([]);
  });
});

describe("a list a page choice filters (ticket 13)", () => {
  const filterBy = { key: "view", options: ["results", "upcoming"] };
  const output = { items: [{ state: "Results" }, { state: "upcoming" }, { state: "results" }] };

  it("asks for the field when the answer does not name it", async () => {
    const { filterIssues } = await import("../src/fit.ts");
    expect(filterIssues(filterBy, ["score → items[].score"], output)[0]).toContain(
      'say the field in covers as "filterBy → <path>"',
    );
    expect(filterIssues(undefined, [], output)).toEqual([]);
  });

  it("passes a field that holds every option, whatever the case the feed writes", async () => {
    const { filterIssues } = await import("../src/fit.ts");
    expect(filterIssues(filterBy, ["filterBy → items[].state"], output)).toEqual([]);
  });

  it("faults an option the field never holds, and an empty field", async () => {
    const { filterIssues } = await import("../src/fit.ts");
    const missing = filterIssues(filterBy, ["filterBy → items[].state"], {
      items: [{ state: "results" }],
    });
    expect(missing[0]).toContain('never holds "upcoming"');
    expect(filterIssues(filterBy, ["filterBy → items[].nothing"], output)[0]).toContain(
      "holds nothing",
    );
  });
});

describe("the design's form is the model's to judge: code reports the values beside the example", () => {
  it("never refuses a value for its form, whatever the example", () => {
    const items = [{ field: "length", required: true, example: "12 min" }];
    const clips = { clips: [{ mins: "4.5" }, { mins: "7.25" }] };
    expect(fitIssues(items, { covers: ["length → clips[].mins"], missing: [] }, clips)).toEqual([]);
  });

  it("shows each path's values beside the example and kind, with how many items have one", () => {
    const items = [
      { field: "length", required: true, example: "12 min" },
      { field: "thumbnail", required: false, kind: "image" as const },
    ];
    const clips = {
      clips: [
        { mins: "4.5", pic: "https://cdn/a.png" },
        { mins: "4.5", pic: "none" },
        { mins: "", pic: "https://cdn/b.png" },
      ],
    };
    const [length, thumb, other] = fieldEvidence(
      items,
      ["length → clips[].mins", "thumbnail → clips[].pic", "views → clips[].views"],
      clips,
    );
    expect(length).toMatchObject({
      field: "length",
      example: "12 min",
      reached: 3,
      filled: 2,
      values: ["4.5"],
    });
    expect(thumb).toMatchObject({ kind: "image", notKind: { count: 1, sample: "none" } });
    expect(other).toMatchObject({ field: null, reached: 0 });
  });

  it("counts the items of each list a path goes through, beside the design's count", () => {
    const days = { days: [{ matches: [{ v: 1 }, { v: 2 }] }, { matches: [{ v: 3 }] }] };
    expect(countEvidence(5, ["venue → days[].matches[].v"], days)).toEqual({
      count: 5,
      lists: [
        { list: "days[]", items: 2 },
        { list: "days[].matches[]", items: 3 },
      ],
    });
  });
});

describe("which items, in what order: the model judges from the dates in output order", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const rows = (...dates: string[]) => ({ rows: dates.map((start) => ({ start })) });
  const cover = ["order → rows[].start"];

  it("asks for the date field when the items carry dates and the answer does not name it", () => {
    expect(orderIssues("newest-first", [], rows("2026-07-01"))[0]).toContain(
      'say the date field the items are ordered by in covers as "order → <path>"',
    );
    expect(orderIssues("as-is", [], rows("2026-07-01"))).toEqual([]);
    expect(orderIssues(undefined, [], rows("2026-07-01"))).toEqual([]);
    expect(orderIssues("newest-first", [], { players: [{ name: "A" }] })).toEqual([]);
  });

  it("never refuses an order: a list of only past items, or dates both ways, is the model's call", () => {
    expect(orderIssues("soonest-first", cover, rows("2026-07-10", "2026-07-12"))).toEqual([]);
    expect(orderIssues("newest-first", cover, rows("2026-06-30", "2026-07-10"))).toEqual([]);
  });

  it("reports the dates in output order, how they run, and how many are before and after now", () => {
    const past = orderEvidence("soonest-first", cover, rows("2026-07-10", "2026-07-12"), now);
    expect(past).toMatchObject({
      order: "soonest-first",
      now: "2026-07-20T12:00:00.000Z",
      path: "rows[].start",
      groups: [
        { dates: ["2026-07-10", "2026-07-12"], runs: "rising", before: 2, after: 0, unread: 0 },
      ],
    });
    const mixed = orderEvidence(
      "upcoming-then-latest",
      cover,
      rows("2026-07-22", "2026-07-25", "2026-07-18", "soon"),
      now,
    );
    expect(mixed).toMatchObject({
      groups: [{ runs: "both ways", before: 1, after: 2, count: 4, unread: 1 }],
    });
    expect(orderEvidence("as-is", cover, rows("2026-07-10"), now)).toBeUndefined();
    expect(orderEvidence("newest-first", [], rows("2026-07-10"), now)).toMatchObject({
      note: expect.stringContaining("order → <path>"),
    });
  });

  it("reports each option's dates on their own when a choice filters the list", () => {
    const joined = {
      events: [
        { cat: "music", at: "2026-07-21T19:00:00Z" },
        { cat: "talks", at: "2026-07-23T09:00:00Z" },
        { cat: "music", at: "2026-07-25T19:00:00Z" },
        { cat: "talks", at: "2026-07-22T09:00:00Z" },
      ],
    };
    const report = orderEvidence(
      "soonest-first",
      ["order → events[].at", "filterBy → events[].cat"],
      joined,
      now,
    );
    expect(report).toMatchObject({
      groups: [
        { option: "music", runs: "rising" },
        { option: "talks", runs: "falling" },
      ],
    });
  });
});

describe("how many items hold each option of a page choice", () => {
  it("counts them as the page compares them", () => {
    expect(
      filterEvidence({ key: "squad", options: ["mens", "womens"] }, ["filterBy → items[].g"], {
        items: [{ g: "Men's" }, { g: "Men's" }, { g: "Women's" }],
      }),
    ).toEqual({
      key: "squad",
      path: "items[].g",
      options: [
        { option: "mens", items: 2 },
        { option: "womens", items: 1 },
      ],
    });
  });
});

describe("the form of a value, for data-bind (ticket 14 review)", async () => {
  const { formOf } = await import("../src/form.ts");
  it("is the same across signs, ordinals, plurals, separators, codes and case", () => {
    expect(formOf("+3")).toBe(formOf("-2"));
    expect(formOf("2nd")).toBe(formOf("1st"));
    expect(formOf("2nd")).not.toBe(formOf("2"));
    expect(formOf("1 Goal")).toBe(formOf("2 Goals"));
    expect(formOf("W 3-1")).toBe(formOf("L 0-2"));
    expect(formOf("5 mins ago")).toBe(formOf("2 hours ago"));
    expect(formOf("1,234")).toBe(formOf("999"));
    expect(formOf("21 JULY")).toBe(formOf("21 July"));
  });
});

describe("a choice's values as the page compares them (ticket 13 review)", async () => {
  const { filterIssues } = await import("../src/fit.ts");
  it("reads an item's field with the page's own rule", () => {
    const output = { items: [{ g: "Men's" }, { g: "Women's" }] };
    expect(
      filterIssues({ key: "squad", options: ["mens", "womens"] }, ["filterBy → items[].g"], output),
    ).toEqual([]);
  });
});
