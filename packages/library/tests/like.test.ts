import { describe, expect, it } from "vitest";
import { type DataShape, fieldNames, rankLike, type Section } from "../src/index.ts";

const shape = (...fields: string[]): DataShape => ({
  lists: [
    {
      path: "fixtures",
      items: 4,
      looks: 1,
      fields: fields.map((path) => ({ path, type: "text" as const })),
    },
  ],
  fields: [],
});

const make = (signature: string, over: Partial<Section> = {}): Section =>
  ({
    signature,
    name: signature,
    kind: "fixtures",
    layout: "row",
    summary: "row of match cards with a team crest, a score and a date",
    hidden: false,
    dataShape: null,
    ...over,
  }) as Section;

describe("like sections (ADR 0034)", () => {
  it("names a shape's fields by their last part", () => {
    expect([...fieldNames(shape("home.name", "score", "date"))].sort()).toEqual([
      "date",
      "name",
      "score",
    ]);
    expect(fieldNames(null).size).toBe(0);
  });

  it("is like one of the same kind and layout that shows mostly the same data", () => {
    const of = make("a", { dataShape: shape("home", "away", "score", "date", "venue") });
    const near = make("b", { dataShape: shape("home", "away", "score", "date", "ticket") });
    const [match] = rankLike(of, [near]);
    expect(match?.section.signature).toBe("b");
    expect(match?.why).toBe("same kind and layout (fixtures, row), 4 of 5 fields alike");
  });

  it("is not like one with another kind or layout, other data, or itself", () => {
    const of = make("a", { dataShape: shape("home", "away", "score", "date") });
    const out = rankLike(of, [
      of,
      make("kind", { kind: "news", dataShape: shape("home", "away", "score", "date") }),
      make("layout", { layout: "grid", dataShape: shape("home", "away", "score", "date") }),
      make("data", { dataShape: shape("title", "image", "author", "read_time") }),
      make("hidden", { hidden: true, dataShape: shape("home", "away", "score", "date") }),
    ]);
    expect(out).toEqual([]);
  });

  it("reads the structure when a section has no data shape, and ranks the nearest first", () => {
    const of = make("a");
    const same = make("same");
    const other = make("other", { summary: "a wide banner with one heading and a button" });
    expect(rankLike(of, [other, same]).map((m) => m.section.signature)).toEqual(["same"]);
    const withShape = make("shaped", { dataShape: shape("home", "away", "score") });
    const exact = make("exact", { dataShape: shape("home", "away", "score") });
    const less = make("less", { dataShape: shape("home", "away", "ticket") });
    expect(rankLike(withShape, [less, exact]).map((m) => m.section.signature)).toEqual([
      "exact",
      "less",
    ]);
  });
});
