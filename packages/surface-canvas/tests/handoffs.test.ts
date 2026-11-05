/**
 * The send model: what the Handoff tab shows while frames go out and the History tab
 * keeps afterwards. Pure, so every state a batch can be in is testable without
 * Figma.
 */
import { describe, expect, it } from "vitest";
import {
  ago,
  cancelWaiting,
  countFrames,
  framesToResend,
  hostOf,
  needsAttention,
  newBatch,
  parseBatches,
  pushBatch,
  batchProblem,
  batchStatus,
  batchTitle,
  setFrame,
  settleInterrupted,
  sortBatches,
  MAX_BATCHES,
  type HandoffBatch,
} from "../src/handoffs.js";

function batch(names: string[], id = "batch-1"): HandoffBatch {
  return newBatch({
    id,
    at: 1_000,
    fileName: "Southern Brave",
    origin: "http://localhost:3000",
    frames: names.map((name, i) => ({ frameId: `1:${i + 1}`, name })),
  });
}

describe("batch status", () => {
  it("starts running: every frame is queued", () => {
    const r = batch(["Home", "Fixtures"]);
    expect(r.finished).toBe(false);
    expect(batchStatus(r)).toBe("running");
    expect(countFrames(r)).toMatchObject({ total: 2, inFlight: 2, sent: 0 });
  });

  it("is sent only when every frame arrived", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent", files: 8 });
    expect(batchStatus(r)).toBe("running");
    r = setFrame(r, "1:2", { status: "sent", files: 11 });
    expect(batchStatus(r)).toBe("sent");
    expect(r.finished).toBe(true);
  });

  it("needs the designer when a frame failed, even though the others arrived", () => {
    let r = batch(["Home", "Fixtures", "Match centre"]);
    r = setFrame(r, "1:1", { status: "sent", files: 8 });
    r = setFrame(r, "1:2", { status: "failed", files: 11, error: "timed out" });
    r = setFrame(r, "1:3", { status: "sent", files: 12 });
    expect(batchStatus(r)).toBe("needs-you");
    expect(needsAttention([r])).toBe(1);
  });

  it("is cancelled, not failed, when the designer stopped it", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent", files: 8 });
    r = cancelWaiting(r);
    expect(batchStatus(r)).toBe("cancelled");
    expect(needsAttention([r])).toBe(0);
  });

  it("does not stop a frame that is already going out", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "uploading", files: 8 });
    r = cancelWaiting(r);
    expect(r.frames.map((f) => f.status)).toEqual(["uploading", "cancelled"]);
    expect(batchStatus(r)).toBe("running");
  });

  it("forgets a failure's reason once the frame is retried", () => {
    let r = batch(["Home"]);
    r = setFrame(r, "1:1", { status: "failed", error: "timed out" });
    expect(r.frames[0]!.error).toBe("timed out");
    r = setFrame(r, "1:1", { status: "waiting" });
    expect(r.frames[0]!.error).toBeUndefined();
  });
});

describe("re-sending", () => {
  it("re-sends only what did not arrive", () => {
    let r = batch(["Home", "Fixtures", "Match centre"]);
    r = setFrame(r, "1:1", { status: "sent" });
    r = setFrame(r, "1:2", { status: "failed", error: "x" });
    r = setFrame(r, "1:3", { status: "cancelled" });
    expect(framesToResend(r).map((f) => f.name)).toEqual(["Fixtures", "Match centre"]);
  });

  it("re-sends everything for a batch that went fine", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent" });
    r = setFrame(r, "1:2", { status: "sent" });
    expect(framesToResend(r)).toHaveLength(2);
  });
});

describe("a plugin that closed mid-send", () => {
  it("settles whatever was in flight as a failure the designer can re-send", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent" });
    r = setFrame(r, "1:2", { status: "uploading" });
    const settled = settleInterrupted(r);
    expect(settled.frames[0]!.status).toBe("sent");
    expect(settled.frames[1]).toMatchObject({ status: "failed" });
    expect(settled.frames[1]!.error).toMatch(/closed/);
    expect(settled.finished).toBe(true);
    expect(batchStatus(settled)).toBe("needs-you");
  });

  it("leaves a finished batch alone", () => {
    let r = batch(["Home"]);
    r = setFrame(r, "1:1", { status: "sent" });
    expect(settleInterrupted(r)).toBe(r);
  });
});

describe("history", () => {
  it("keeps the newest first and caps it", () => {
    let batches: HandoffBatch[] = [];
    for (let i = 0; i < MAX_BATCHES + 5; i++) batches = pushBatch(batches, batch(["Home"], `batch-${i}`));
    expect(batches).toHaveLength(MAX_BATCHES);
    expect(batches[0]!.id).toBe(`batch-${MAX_BATCHES + 4}`);
  });

  it("survives a round trip through clientStorage", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:2", { status: "failed", files: 5, error: "timed out" });
    const parsed = parseBatches(JSON.parse(JSON.stringify([r])));
    expect(parsed).toEqual([r]);
  });

  it("drops anything malformed instead of refusing to open", () => {
    const good = batch(["Home"]);
    const parsed = parseBatches([
      null,
      "nope",
      { id: 7 },
      { id: "a", at: 1, frames: [] },
      { id: "b", at: 1, frames: [{ frameId: "1", name: "X", status: "exploded" }] },
      good,
    ]);
    expect(parsed).toEqual([good]);
    expect(parseBatches(undefined)).toEqual([]);
    expect(parseBatches({})).toEqual([]);
  });
});

describe("the History order", () => {
  it("puts what needs the designer first, then what is running, newest first within each", () => {
    const sent = (id: string, at: number): HandoffBatch => ({
      ...setFrame(batch(["A"], id), "1:1", { status: "sent" }),
      at,
    });
    const failed = { ...setFrame(batch(["B"], "failed"), "1:1", { status: "failed" }), at: 1 };
    const going = { ...batch(["C"], "going"), at: 2 };

    const sorted = sortBatches([sent("new", 900), going, sent("old", 100), failed]);
    expect(sorted.map((r) => r.id)).toEqual(["failed", "going", "new", "old"]);
  });
});

describe("the words", () => {
  it("titles a batch by its frames, trimming a long one", () => {
    expect(batchTitle(batch(["Home", "Fixtures", "Match centre"]))).toBe("Home · Fixtures · Match centre");
    expect(batchTitle(batch(["A", "B", "C", "D", "E"]))).toBe("A · B · C · +2");
  });

  it("says what went wrong in one sentence", () => {
    let r = batch(["Home", "Fixtures"]);
    r = setFrame(r, "1:2", { status: "failed", error: "timed out" });
    expect(batchProblem(r)).toBe("Fixtures: timed out");
    r = setFrame(r, "1:1", { status: "failed" });
    expect(batchProblem(r)).toBe("2 frames didn’t make it. Home: didn’t finish uploading");
  });

  it("is coarse about time", () => {
    const now = 10 * 3_600_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(ago(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(ago(now - 50 * 3_600_000, now)).toBe("2 d ago");
  });

  it("shows a host without the scheme", () => {
    expect(hostOf("http://localhost:3000/")).toBe("localhost:3000");
    expect(hostOf("")).toBe("");
  });
});
