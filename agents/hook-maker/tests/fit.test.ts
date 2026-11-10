import { describe, expect, it } from "vitest";
import { fitIssues, isKind, parseCover, valuesAt } from "../src/fit.ts";

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
    expect(issues).toContain(
      '"team crest" is required by the need and is in neither covers nor missing: say which',
    );
    expect(issues).toHaveLength(2);
  });

  it("faults a value of the wrong kind, such as a name where a picture is drawn", () => {
    const wrong = { rows: [{ crest: "Southern Brave" }, { crest: "Brave" }] };
    const issues = fitIssues(
      [{ field: "team crest", required: true, kind: "image" }],
      { covers: ["team crest → rows[].crest"], missing: [] },
      wrong,
    );
    expect(issues[0]).toContain("should read as a image");
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

describe("the design's form (ticket 14)", () => {
  const items = [{ field: "balls faced", required: true, example: "(100 Balls)" }];

  it("faults overs passed through where the design writes balls, and passes the derived number", () => {
    const overs = { rows: [{ balls: "19.3" }, { balls: "20.0" }] };
    const issues = fitIssues(items, { covers: ["balls faced → rows[].balls"], missing: [] }, overs);
    expect(issues[0]).toContain('holds "19.3" where the design writes "(100 Balls)"');
    expect(issues[0]).toContain("derive what the design shows");
  });

  it("passes a value in the design's form, a count with its unit among them", () => {
    const derived = { rows: [{ balls: "(98 Balls)" }, { balls: "(100 Balls)" }] };
    expect(
      fitIssues(items, { covers: ["balls faced → rows[].balls"], missing: [] }, derived),
    ).toEqual([]);
  });

  it("leaves a date or a time as the instant, and a field with no figure in its example alone", () => {
    const dated = [
      { field: "kick-off", required: true, kind: "date" as const, example: "21 JULY" },
      { field: "role", required: false, example: "Batter" },
    ];
    expect(
      fitIssues(
        dated,
        { covers: ["kick-off → rows[].start", "role → rows[].role"], missing: [] },
        { rows: [{ start: "2026-07-21T19:30:00Z", role: "Bowler" }] },
      ),
    ).toEqual([]);
  });
});

describe("which items, in what order (ticket 15)", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const rows = (...dates: string[]) => ({ rows: dates.map((start) => ({ start })) });
  const cover = ["order → rows[].start"];

  it("asks for the date field when the answer does not name it", async () => {
    const { orderIssues } = await import("../src/fit.ts");
    expect(orderIssues("newest-first", [], rows("2026-07-01"), now)[0]).toContain(
      'say the date field the items are ordered by in covers as "order → <path>"',
    );
    expect(orderIssues("as-is", [], rows("2026-07-01"), now)).toEqual([]);
    expect(orderIssues(undefined, [], rows("2026-07-01"), now)).toEqual([]);
  });

  it("upcoming then latest: what is next first, then results from the latest back", async () => {
    const { orderIssues } = await import("../src/fit.ts");
    const good = rows("2026-07-22", "2026-07-25", "2026-07-18", "2026-07-10");
    expect(orderIssues("upcoming-then-latest", cover, good, now)).toEqual([]);
    // the season's first three results, as a schedule sorted ascending gives them
    const wrong = rows("2026-07-10", "2026-07-18", "2026-07-22");
    expect(orderIssues("upcoming-then-latest", cover, wrong, now)[0]).toContain(
      "not upcoming then latest",
    );
  });

  it("wants what is next: only past items is a fault, unless missing says nothing is to come", async () => {
    const { orderIssues } = await import("../src/fit.ts");
    const past = rows("2026-07-10", "2026-07-12");
    expect(orderIssues("soonest-first", cover, past, now)[0]).toContain("holds only past items");
    expect(
      orderIssues("upcoming-then-latest", cover, rows("2026-07-12", "2026-07-10"), now)[0],
    ).toContain("holds only past items");
    expect(
      orderIssues("soonest-first", cover, past, now, ["no upcoming fixtures in the feed"]),
    ).toEqual([]);
    // articles are past by nature
    expect(orderIssues("newest-first", cover, rows("2026-07-12", "2026-07-10"), now)).toEqual([]);
  });

  it("newest first: articles from the latest back", async () => {
    const { orderIssues } = await import("../src/fit.ts");
    expect(
      orderIssues("newest-first", cover, rows("2026-07-18", "2026-07-10", "2026-06-30"), now),
    ).toEqual([]);
    expect(orderIssues("newest-first", cover, rows("2026-06-30", "2026-07-10"), now)[0]).toContain(
      "not newest first",
    );
  });

  it("soonest first: starts at the next one, not at a past date", async () => {
    const { orderIssues } = await import("../src/fit.ts");
    expect(orderIssues("soonest-first", cover, rows("2026-07-21", "2026-07-23"), now)).toEqual([]);
    expect(orderIssues("soonest-first", cover, rows("2026-07-10", "2026-07-23"), now)[0]).toContain(
      "starts with a past date",
    );
    expect(orderIssues("soonest-first", cover, rows("2026-07-23", "2026-07-21"), now)[0]).toContain(
      "not soonest first",
    );
  });
});

describe("a field compared with the part of the example it fills (ticket 14 review)", () => {
  it("passes the number a design writes words around, and a score given apart", () => {
    const balls = [{ field: "balls faced", required: true, example: "(100 Balls)" }];
    expect(
      fitIssues(
        balls,
        { covers: ["balls faced → rows[].balls"], missing: [] },
        {
          rows: [{ balls: 98 }, { balls: "100" }],
        },
      ),
    ).toEqual([]);
    const runs = [{ field: "runs", required: true, kind: "score" as const, example: "166/5" }];
    expect(
      fitIssues(
        runs,
        { covers: ["runs → rows[].runs"], missing: [] },
        {
          rows: [{ runs: "166" }, { runs: "98" }],
        },
      ),
    ).toEqual([]);
    // a video's length in minutes: the number, not the seconds' decimal minutes
    const length = [{ field: "length", required: true, example: "12 min" }];
    expect(
      fitIssues(
        length,
        { covers: ["length → clips[].mins"], missing: [] },
        {
          clips: [{ mins: "4.5" }, { mins: "7.25" }],
        },
      )[0],
    ).toContain('where the design writes "12 min"');
  });

  it("still faults another unit's words", () => {
    const balls = [{ field: "balls faced", required: true, example: "(100 Balls)" }];
    expect(
      fitIssues(
        balls,
        { covers: ["balls faced → rows[].balls"], missing: [] },
        {
          rows: [{ balls: "(20 Overs)" }],
        },
      )[0],
    ).toContain("derive what the design shows");
  });
});

describe("the form of a value (ticket 14 review)", async () => {
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
    expect(formOf("(20.0 Overs)")).not.toBe(formOf("(100 Balls)"));
  });
});

describe("which items, in what order: the review (ticket 15)", async () => {
  const { orderIssues } = await import("../src/fit.ts");
  const now = Date.parse("2026-07-20T12:00:00Z");

  it("orders each option's items on their own when a choice filters the list", () => {
    // two feeds joined, each sorted soonest first
    const joined = {
      events: [
        { cat: "music", at: "2026-07-21T19:00:00Z" },
        { cat: "music", at: "2026-07-25T19:00:00Z" },
        { cat: "talks", at: "2026-07-22T09:00:00Z" },
        { cat: "talks", at: "2026-07-23T09:00:00Z" },
      ],
    };
    const covers = ["order → events[].at", "filterBy → events[].cat"];
    expect(orderIssues("soonest-first", covers, joined, now)).toEqual([]);
    expect(orderIssues("soonest-first", ["order → events[].at"], joined, now)[0]).toContain(
      "not soonest first",
    );
    const wrong = { events: [...joined.events].reverse() };
    expect(orderIssues("soonest-first", covers, wrong, now)[0]).toContain('option "talks"');
  });

  it("lets soonest first start with an item under way", () => {
    const rows = { rows: [{ at: "2026-07-20T11:00:00Z" }, { at: "2026-07-21T19:00:00Z" }] };
    expect(orderIssues("soonest-first", ["order → rows[].at"], rows, now)).toEqual([]);
    const live = {
      rows: [
        { at: "2026-07-20T11:00:00Z" },
        { at: "2026-07-21T19:00:00Z" },
        { at: "2026-07-18T19:00:00Z" },
      ],
    };
    expect(orderIssues("upcoming-then-latest", ["order → rows[].at"], live, now)).toEqual([]);
  });

  it("does not ask an undated list for its date field, and skips dates it cannot read", () => {
    const undated = { players: [{ name: "A" }, { name: "B" }] };
    expect(orderIssues("newest-first", [], undated, now)).toEqual([]);
    expect(orderIssues("newest-first", [], { rows: [{ at: "2026-07-01" }] }, now)[0]).toContain(
      "order → <path>",
    );
    const some = { rows: [{ at: "2026-07-18" }, { at: "soon" }, { at: "2026-07-10" }] };
    expect(orderIssues("newest-first", ["order → rows[].at"], some, now)).toEqual([]);
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
