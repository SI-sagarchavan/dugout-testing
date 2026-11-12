/**
 * A tone the model gives a text is reported beside the colour the IR paints that text: a white
 * title made blue on a blue band scores as well, because the band's pixels match. Reported, never
 * refused: the agent reads both.
 */
import { describe, expect, it } from "vitest";
import { toneAgainstDesign } from "../src/frame.ts";

const bundle = {
  themeRaw: {
    tokens: {
      t: {
        color: {
          light: { text_sec_high: "#eaecfa", core_sec_500: "#2939a3", text_invert_high: "#ffffff" },
        },
      },
    },
  },
  byId: new Map<string, unknown>([
    ["1:title", { type: "TEXT", fill: { tokenRef: "text/sec/high", unbound: false } }],
    ["1:box", { type: "FRAME", fill: { tokenRef: "core/sec/500" } }],
  ]),
} as never;

describe("a tone beside the design's own colour", () => {
  it("is reported with both colours and how far apart they are", () => {
    expect(
      toneAgainstDesign(bundle, [{ src: "1:title", props: { tone: "color.core_sec_500" } }]),
    ).toEqual([
      {
        src: "1:title",
        design: "text/sec/high (#eaecfa)",
        tone: "color.core_sec_500 (#2939a3)",
        distance: 277,
      },
    ]);
    expect(
      toneAgainstDesign(bundle, [{ src: "1:title", props: { tone: "color.text_invert_high" } }])[0]
        ?.distance,
    ).toBe(29);
  });

  it("says nothing when the IR cannot say, or no tone is set", () => {
    expect(
      toneAgainstDesign(bundle, [{ src: "1:box", props: { tone: "color.core_sec_500" } }]),
    ).toEqual([]);
    expect(
      toneAgainstDesign(bundle, [{ src: "1:title", props: { surface: "surface.x" } }]),
    ).toEqual([]);
  });
});
