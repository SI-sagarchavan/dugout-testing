import { describe, expect, it } from "vitest";
import { framesToSend, sendLabel } from "../src/ui/frames.js";
import { initialState, type StudioState } from "../src/ui/state.js";

const withFrames = (frames: StudioState["selectionFrames"]): StudioState => ({
  ...initialState,
  selectionFrames: frames,
});

describe("which frames a Send carries", () => {
  it("is the selection when it holds containers", () => {
    const state = withFrames([
      { id: "1:1", name: "Home" },
      { id: "1:2", name: "Fixtures" },
    ]);
    expect(framesToSend(state).map((frame) => frame.name)).toEqual(["Home", "Fixtures"]);
  });

  it("is nothing when nothing is selected and nothing is checked", () => {
    expect(framesToSend(initialState)).toEqual([]);
  });

  it("labels the button for what it will do", () => {
    expect(sendLabel([])).toBe("Select a frame");
    expect(sendLabel([{ id: "1", name: "a" }])).toBe("Send 1 frame");
    expect(
      sendLabel([
        { id: "1", name: "a" },
        { id: "2", name: "b" },
      ]),
    ).toBe("Send 2 frames");
  });
});
