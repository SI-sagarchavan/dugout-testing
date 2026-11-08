/** `propsAtPlace`: what a renderer draws for a node at its item's place. */
import { describe, expect, it } from "vitest";
import { placesOf, propsAtPlace } from "../src/positional.js";

describe("placesOf", () => {
  it("names each item's places; the first is even", () => {
    expect(placesOf({ index: 0, count: 3 })).toEqual(["even", "first"]);
    expect(placesOf({ index: 1, count: 3 })).toEqual(["odd", "middle"]);
    expect(placesOf({ index: 2, count: 3 })).toEqual(["even", "last"]);
  });

  it("a single item is both first and last", () => {
    expect(placesOf({ index: 0, count: 1 })).toEqual(["even", "first", "last"]);
  });
});

describe("propsAtPlace", () => {
  const props = { surface: "surface.ruled", tone: "color.a", at: { last: { surface: null }, odd: { tone: "color.b" } } };

  it("writes the place's props over the node's own, null removing one", () => {
    expect(propsAtPlace(props, { index: 2, count: 3 })).toMatchObject({ tone: "color.a" });
    expect(propsAtPlace(props, { index: 2, count: 3 })).not.toHaveProperty("surface");
    expect(propsAtPlace(props, { index: 1, count: 3 })).toMatchObject({ surface: "surface.ruled", tone: "color.b" });
  });

  it("draws nothing where it is hidden", () => {
    expect(propsAtPlace({ at: { last: { hidden: true } } }, { index: 1, count: 2 })).toBeUndefined();
    expect(propsAtPlace({ at: { last: { hidden: true } } }, { index: 0, count: 2 })).toBeDefined();
  });

  it("a later place wins: last over middle over odd", () => {
    const p = { at: { odd: { tone: "o" }, middle: { tone: "m" }, last: { tone: "l" } } };
    expect(propsAtPlace(p, { index: 3, count: 4 })?.tone).toBe("l");
    expect(propsAtPlace(p, { index: 1, count: 4 })?.tone).toBe("m");
  });

  it("is the node's own props outside a Repeater, the same object", () => {
    expect(propsAtPlace(props, undefined)).toBe(props);
    const plain = { tone: "x" };
    expect(propsAtPlace(plain, { index: 0, count: 1 })).toBe(plain);
  });
});
