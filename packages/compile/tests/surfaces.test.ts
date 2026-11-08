/**
 * A stroke on some sides only (IR 1.12.0 `stroke.sides`): a stat's rule on its right, a row's
 * underneath. Before, the IR took the top side's weight and the surface drew a border all round,
 * or none.
 */
import { describe, expect, it } from "vitest";
import { loadTheme } from "@fanos/tokens";
import type { FrameIRNode } from "@fanos/surface-canvas/ir";
import { specOf } from "../src/surfaces.js";

const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;
const theme = loadTheme(THEME);

const node = (stroke: FrameIRNode["stroke"]) =>
  ({ name: "stat", fill: null, stroke, radius: null, effects: [] }) as unknown as FrameIRNode;

describe("specOf — a stroke's sides", () => {
  const colour = { tokenRef: "background/main/surface", unbound: false };

  it("draws a stroke on every side as a plain border", () => {
    const spec = specOf(theme, node({ ...colour, weight: 1 }));
    expect(spec?.borders?.[0]).toMatchObject({ width: 1 });
    expect(spec?.borders?.[0]?.sides).toBeUndefined();
  });

  it("keeps the sides a stroke is on, as logical sides", () => {
    const spec = specOf(
      theme,
      node({ ...colour, weight: 2, sides: { top: 0, right: 1, bottom: 2, left: 0 } }),
    );
    expect(spec?.borders?.[0]).toMatchObject({ width: 2, sides: { end: 1, bottom: 2 } });
  });
});
