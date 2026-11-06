import { describe, expect, it } from "vitest";
import type { PanelControl } from "../src/index.js";
import { measureOf, measureText, panelOf, propIssues, propNamesOf, readProp, shownValue, storedValue } from "../src/index.js";

const paths = (type: string) => panelOf(type).flatMap((g) => g.fields.map((f) => f.path));
const field = (type: string, path: string) =>
  panelOf(type)
    .flatMap((g) => g.fields)
    .find((f) => f.path === path);

describe("panelOf", () => {
  it("gives a Stack its own layout props and the universal ones", () => {
    const groups = panelOf("Stack");
    expect(groups.map((g) => g.id)).toEqual(expect.arrayContaining(["layout", "size", "space", "look"]));
    const layout = groups.find((g) => g.id === "layout");
    expect(layout?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(["direction", "gap", "align", "justify", "wrap"]),
    );
    expect(paths("Stack")).toEqual(expect.arrayContaining(["size.w", "space.px", "surface"]));
  });

  it("draws an enum as a select and a number as a number", () => {
    expect(field("Stack", "direction")?.control).toEqual({ k: "select", options: ["row", "column"] });
    expect(field("Stack", "gap")?.control).toMatchObject({ k: "measure", category: "space" });
    expect(field("Stack", "wrap")?.control).toEqual({ k: "toggle" });
  });

  it("flattens object props to dotted paths and keeps size keywords", () => {
    expect(field("Box", "size.w")?.control).toMatchObject({ k: "measure", keywords: ["full", "auto"], percent: true });
    expect(field("Box", "place.anchor")?.control).toMatchObject({ k: "select" });
  });

  it("puts a leaf's own props under content", () => {
    const content = panelOf("Text").find((g) => g.id === "content");
    expect(content?.fields.length).toBeGreaterThan(0);
  });

  it("leaves out props that are edited through a comment instead", () => {
    expect(paths("Stack")).not.toContain("when");
    expect(paths("Stack")).not.toContain("states");
  });

  it("tells two props of one name apart, and keeps only the note of _meta", () => {
    const labels = panelOf("Button").flatMap((g) => g.fields.map((f) => f.label));
    expect(new Set(labels).size).toBe(labels.length);
    expect(paths("Button")).toContain("_meta.note");
    expect(paths("Button")).not.toContain("_meta.fidelity");
  });

  it("is empty for a type the vocabulary does not have", () => {
    expect(panelOf("Nope")).toEqual([]);
  });
});

describe("panel values", () => {
  it("reads a dotted path", () => {
    expect(readProp({ size: { w: "full" } }, "size.w")).toBe("full");
    expect(readProp({}, "size.w")).toBeUndefined();
  });

  it("shows a responsive prop's base and changes only the base", () => {
    const current = { base: "space.2", lg: "space.8" };
    expect(shownValue(current, true)).toBe("space.2");
    expect(storedValue(current, "space.4", true)).toEqual({ base: "space.4", lg: "space.8" });
    expect(storedValue(current, undefined, true)).toEqual({ lg: "space.8" });
    expect(storedValue("space.2", "space.4", true)).toBe("space.4");
  });

  it("reads a typed measure as a keyword, a token, a percent or a raw px", () => {
    const control: Extract<PanelControl, { k: "measure" }> = {
      k: "measure",
      category: "space",
      keywords: ["full", "auto"],
      percent: true,
      signed: false,
    };
    expect(measureOf("full", control)).toBe("full");
    expect(measureOf("space.4", control)).toBe("space.4");
    expect(measureOf("50%", control)).toBe("50%");
    expect(measureOf("12", control)).toEqual({ raw: 12, _unbound: true });
    expect(measureOf("", control)).toBeUndefined();
    expect(measureOf("abc", control)).toBeUndefined();
    expect(measureText({ raw: 12, _unbound: true })).toBe("12");
  });
});

describe("propIssues", () => {
  it("accepts what the type declares and says what it does not", () => {
    expect(propIssues("Stack", { direction: "row", gap: "space.4" })).toEqual([]);
    expect(propIssues("Stack", { direction: "diagonal" })[0]).toMatch(/^direction/);
    expect(propIssues("Stack", { colour: "red" }).join()).toMatch(/colour|Unrecognized/i);
    expect(propIssues("Nope", {})[0]).toMatch(/unknown node type/);
  });
  it("lists a type's prop names, universal ones included", () => {
    expect(propNamesOf("Stack")).toEqual(expect.arrayContaining(["gap", "direction", "size", "space"]));
    expect(propNamesOf("Nope")).toEqual([]);
  });
});
