/**
 * A text the compiler dropped for want of an exact style is put back by frame-match. It must read
 * as the compiler would have drawn it: a centred role label down a card's edge, put back without
 * its `align`, drew from one end of its box, so every role but the design's sat off-centre.
 */
import { describe, expect, it } from "vitest";
import { textLook } from "../src/frame.ts";

describe("textLook", () => {
  it("keeps a centred, upper-cased label centred and in capitals", () => {
    // the role label of the player card: 12px/700, lh 26, turned 90°, centred in a 159px box
    expect(
      textLook({ textAlignHorizontal: "CENTER", textCase: "UPPER", lineHeight: 26, lines: 1 }, 8),
    ).toEqual({ align: "center", textCase: "upper" });
  });

  it("reads a right-aligned text as end", () => {
    expect(textLook({ textAlignHorizontal: "RIGHT" }, 20)).toEqual({ align: "end" });
  });

  it("says nothing of a left-aligned text in its own case", () => {
    expect(textLook({ textAlignHorizontal: "LEFT" }, 20)).toEqual({});
  });

  it("marks a box exactly lines × line height as untrimmed", () => {
    expect(textLook({ lineHeight: 24, lines: 2 }, 48)).toEqual({ trim: "none" });
  });

  it("leaves a case the DSL cannot say alone", () => {
    expect(textLook({ textCase: "SMALL_CAPS" }, 20)).toEqual({});
  });
});
