/**
 * Which frames a Handoff would carry.
 *
 * PURE. The selection when it holds containers, because that is what a designer
 * who selected three frames and pressed Handoff means. Otherwise the frame being
 * checked, so a designer who never touched the selection can still send what
 * they have been working on. Nothing at all is an honest answer: the button then
 * says what to do instead of sending an empty run.
 */
import type { SelectedFrame } from "../protocol.js";
import type { StudioState } from "./state.js";

export function framesToHandoff(state: StudioState): SelectedFrame[] {
  if (state.selectionFrames.length > 0) return state.selectionFrames;
  const report = state.report;
  if (report && report.rootNodeId) {
    return [{ id: report.rootNodeId, name: report.rootName || "Frame" }];
  }
  return [];
}

export function handoffLabel(frames: readonly SelectedFrame[]): string {
  if (frames.length === 0) return "Select a frame";
  return `Hand off ${frames.length} ${frames.length === 1 ? "frame" : "frames"}`;
}
