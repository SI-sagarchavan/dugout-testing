import { describe, expect, it } from "vitest";
import {
  type DataOutcome,
  dataFormat,
  dataOrder,
  formOf,
  gradeData,
  holdsText,
  schemaIssues,
} from "../src/index.ts";

const outcome = (over: Partial<DataOutcome> = {}): DataOutcome => ({
  status: "completed",
  ending: "bound",
  hookId: "dugout_brave_squad",
  hookOutput: { women: [{ name: "Sophie Devine", team: "Southern Brave" }] },
  shown: [{ node: "n1", placeholder: "Player Name", shown: ["Sophie Devine"] }],
  boundFields: ["name", "team"],
  problems: [],
  variantsDrawn: [],
  steps: 12,
  costUsd: 0.4,
  ...over,
});
const grades = (o: DataOutcome, e: Parameters<typeof gradeData>[0]) =>
  Object.fromEntries(gradeData(e, o).map((g) => [g.grader, g.pass]));

describe("the form of a text", () => {
  it("tells the design's date and unit from another form of it", () => {
    expect(formOf("21 JULY")).toBe("9 month^");
    expect(formOf("5/26/2026")).toBe("9/9/9");
    expect(formOf("(100 Balls)")).toBe("(9 balls~)");
    expect(formOf("(20.0 Overs)")).toBe("(9 overs~)");
    expect(formOf("166/5")).toBe("9/9");
    expect(formOf("19:30")).toBe("9:9");
  });

  it("faults 5/26/2026 where the design writes 21 JULY, and (Overs) for (100 Balls)", () => {
    const g = dataFormat(
      outcome({
        shown: [
          { node: "d", placeholder: "21 JULY", shown: ["26 MAY", "5/26/2026"] },
          { node: "b", placeholder: "(100 Balls)", shown: ["Overs"] },
        ],
      }),
    );
    expect(g.pass).toBe(false);
    expect(g.detail).toContain('d: "5/26/2026" where the design writes "21 JULY"');
    expect(g.detail).toContain('b: "Overs"');
  });
});

describe("which placeholders have a form to keep", () => {
  it("grades dates, times, scores and counts, and leaves names, labels and sentences alone", () => {
    const g = dataFormat(
      outcome({
        shown: [
          { node: "a", placeholder: "Batter", shown: ["All-Rounder"] },
          { node: "b", placeholder: "WOMEN", shown: ["Men"] },
          { node: "c", placeholder: "Southern Brave beat Giants by 6 runs", shown: ["RCB won"] },
          { node: "d", placeholder: "166/5", shown: ["172/3", "9/0"] },
        ],
      }),
    );
    expect(g.pass).toBe(true);
  });
});

describe("the data is about the design's team", () => {
  it("holds a team by its words", () => {
    expect(holdsText("Sophie Devine, Southern Brave", "Southern Brave")).toBe(true);
    expect(holdsText("Glenn Maxwell, Punjab Kings", "Southern Brave")).toBe(false);
  });

  it("fails the run 3acd204c: an IPL squad bound where the design is the Southern Brave", () => {
    const wrong = outcome({
      hookId: "dugout_ipl_squad",
      hookOutput: { players: [{ name: "Glenn Maxwell", team: "Punjab Kings" }] },
      shown: [{ node: "n1", placeholder: "Player Name", shown: ["Glenn Maxwell"] }],
    });
    const g = grades(wrong, { ending: "bound", must: { team: "Southern Brave" } });
    expect(g["right-entity"]).toBe(false);
    // the same data reported as a stand-in is honest, and a case that expects one passes
    expect(grades({ ...wrong, ending: "stand-in" }, { ending: "stand-in" }).ending).toBe(true);
    expect(grades(wrong, { ending: "stand-in" }).ending).toBe(false);
  });
});

describe("the other graders", () => {
  it("passes a slot that is bound to its own data, in form, with everything drawn", () => {
    const g = grades(outcome({ variantsDrawn: ["R", "U"] }), {
      ending: "bound",
      hook: { id: "dugout_brave_squad" },
      must: { team: "Southern Brave" },
      required: ["name"],
      variants: ["R", "U"],
    });
    expect(Object.values(g).every(Boolean)).toBe(true);
  });

  it("faults a required field nothing binds, and a variant nobody draws", () => {
    const g = grades(outcome({ boundFields: ["name"], variantsDrawn: ["R"] }), {
      ending: "bound",
      required: ["name", "start_date"],
      variants: ["R", "U"],
    });
    expect(g.coverage).toBe(false);
    expect(g.variants).toBe(false);
  });

  it("takes a hook whose output passes the schema in place of the expected id", () => {
    const schema = {
      type: "object",
      required: ["women", "men"],
      properties: { women: { type: "array", items: { type: "object", required: ["name"] } } },
    };
    expect(schemaIssues({ women: [{ name: "a" }], men: [] }, schema)).toEqual([]);
    expect(schemaIssues({ women: [{}] }, schema)).toEqual(
      ["$.women[0].name: missing", "$.men: missing"].sort().reverse().sort(),
    );
    const g = grades(outcome({ hookId: "another", hookOutput: { women: [] } }), {
      ending: "bound",
      hook: { id: "dugout_brave_squad", schema },
    });
    expect(g.hook).toBe(false);
  });

  it("grades a slot that ends none or a failed run on its ending alone", () => {
    expect(grades(outcome({ ending: "none", shown: [] }), { ending: "none" })).toEqual({
      "no-failed-run": true,
      ending: true,
      "cost-and-steps": true,
    });
    const failed = grades(outcome({ status: "failed", ending: undefined }), { ending: "bound" });
    expect(failed["no-failed-run"]).toBe(false);
    expect(failed.ending).toBe(false);
  });
});

describe("the order of the dated lists (ticket 15)", () => {
  const day = (iso: string) => Date.parse(iso);
  const at = day("2026-07-20T12:00:00Z");
  const dated = (...isos: string[]) =>
    outcome({ at, dated: [{ list: "news.items", times: isos.map(day) }] });

  it("passes articles from the latest back, faults them oldest first", () => {
    expect(dataOrder("newest-first", dated("2026-07-18", "2026-07-10", "2026-06-30")).pass).toBe(
      true,
    );
    const wrong = dataOrder("newest-first", dated("2026-06-30", "2026-07-10"));
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain("not newest first");
  });

  it("faults a fixtures list that starts with last week's result, or holds only past items", () => {
    expect(dataOrder("soonest-first", dated("2026-07-21", "2026-07-23")).pass).toBe(true);
    expect(dataOrder("soonest-first", dated("2026-07-10", "2026-07-23")).detail).toContain(
      "starts with past",
    );
    const none = dataOrder("upcoming-then-latest", dated("2026-07-18", "2026-07-10"));
    expect(none.pass).toBe(false);
    expect(none.detail).toContain("only past items");
    expect(
      dataOrder("upcoming-then-latest", dated("2026-07-22", "2026-07-18", "2026-07-10")).pass,
    ).toBe(true);
  });

  it("asks nothing of a case with no order, or a list of one", () => {
    expect(dataOrder(undefined, dated("2026-06-30", "2026-07-10")).pass).toBe(true);
    expect(dataOrder("newest-first", dated("2026-06-30")).pass).toBe(true);
  });

  it("is one of the grades of a bound case that expects an order", () => {
    const g = grades(dated("2026-06-30", "2026-07-10"), { ending: "bound", order: "newest-first" });
    expect(g.order).toBe(false);
  });
});
