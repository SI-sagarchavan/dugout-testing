import { describe, expect, it } from "vitest";
import { framesToHandoff, handoffLabel } from "../src/ui/frames.js";
import { initialState, type StudioState } from "../src/ui/state.js";

const withFrames = (frames: StudioState["selectionFrames"]): StudioState => ({
  ...initialState,
  selectionFrames: frames,
});

describe("which frames a Handoff carries", () => {
  it("is the selection when it holds containers", () => {
    const state = withFrames([
      { id: "1:1", name: "Home" },
      { id: "1:2", name: "Fixtures" },
    ]);
    expect(framesToHandoff(state).map((frame) => frame.name)).toEqual(["Home", "Fixtures"]);
  });

  it("is nothing when nothing is selected and nothing is checked", () => {
    expect(framesToHandoff(initialState)).toEqual([]);
  });

  it("labels the button for what it will do", () => {
    expect(handoffLabel([])).toBe("Select a frame");
    expect(handoffLabel([{ id: "1", name: "a" }])).toBe("Hand off 1 frame");
    expect(
      handoffLabel([
        { id: "1", name: "a" },
        { id: "2", name: "b" },
      ]),
    ).toBe("Hand off 2 frames");
  });
});
