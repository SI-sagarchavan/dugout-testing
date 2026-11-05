/**
 * The send model: what the Send tab shows while frames go out and the Runs tab
 * keeps afterwards. Pure, so every state a run can be in is testable without
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
  newRun,
  parseRuns,
  pushRun,
  runProblem,
  runStatus,
  runTitle,
  setFrame,
  settleInterrupted,
  sortRuns,
  MAX_RUNS,
  type RunRecord,
} from "../src/sends.js";

function run(names: string[], id = "run-1"): RunRecord {
  return newRun({
    id,
    at: 1_000,
    fileName: "Southern Brave",
    origin: "http://localhost:3000",
    frames: names.map((name, i) => ({ frameId: `1:${i + 1}`, name })),
  });
}

describe("run status", () => {
  it("starts running: every frame is queued", () => {
    const r = run(["Home", "Fixtures"]);
    expect(r.finished).toBe(false);
    expect(runStatus(r)).toBe("running");
    expect(countFrames(r)).toMatchObject({ total: 2, inFlight: 2, sent: 0 });
  });

  it("is sent only when every frame arrived", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent", files: 8 });
    expect(runStatus(r)).toBe("running");
    r = setFrame(r, "1:2", { status: "sent", files: 11 });
    expect(runStatus(r)).toBe("sent");
    expect(r.finished).toBe(true);
  });

  it("needs the designer when a frame failed, even though the others arrived", () => {
    let r = run(["Home", "Fixtures", "Match centre"]);
    r = setFrame(r, "1:1", { status: "sent", files: 8 });
    r = setFrame(r, "1:2", { status: "failed", files: 11, error: "timed out" });
    r = setFrame(r, "1:3", { status: "sent", files: 12 });
    expect(runStatus(r)).toBe("needs-you");
    expect(needsAttention([r])).toBe(1);
  });

  it("is cancelled, not failed, when the designer stopped it", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent", files: 8 });
    r = cancelWaiting(r);
    expect(runStatus(r)).toBe("cancelled");
    expect(needsAttention([r])).toBe(0);
  });

  it("does not stop a frame that is already going out", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "uploading", files: 8 });
    r = cancelWaiting(r);
    expect(r.frames.map((f) => f.status)).toEqual(["uploading", "cancelled"]);
    expect(runStatus(r)).toBe("running");
  });

  it("forgets a failure's reason once the frame is retried", () => {
    let r = run(["Home"]);
    r = setFrame(r, "1:1", { status: "failed", error: "timed out" });
    expect(r.frames[0]!.error).toBe("timed out");
    r = setFrame(r, "1:1", { status: "waiting" });
    expect(r.frames[0]!.error).toBeUndefined();
  });
});

describe("re-sending", () => {
  it("re-sends only what did not arrive", () => {
    let r = run(["Home", "Fixtures", "Match centre"]);
    r = setFrame(r, "1:1", { status: "sent" });
    r = setFrame(r, "1:2", { status: "failed", error: "x" });
    r = setFrame(r, "1:3", { status: "cancelled" });
    expect(framesToResend(r).map((f) => f.name)).toEqual(["Fixtures", "Match centre"]);
  });

  it("re-sends everything for a run that went fine", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent" });
    r = setFrame(r, "1:2", { status: "sent" });
    expect(framesToResend(r)).toHaveLength(2);
  });
});

describe("a plugin that closed mid-send", () => {
  it("settles whatever was in flight as a failure the designer can re-send", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:1", { status: "sent" });
    r = setFrame(r, "1:2", { status: "uploading" });
    const settled = settleInterrupted(r);
    expect(settled.frames[0]!.status).toBe("sent");
    expect(settled.frames[1]).toMatchObject({ status: "failed" });
    expect(settled.frames[1]!.error).toMatch(/closed/);
    expect(settled.finished).toBe(true);
    expect(runStatus(settled)).toBe("needs-you");
  });

  it("leaves a finished run alone", () => {
    let r = run(["Home"]);
    r = setFrame(r, "1:1", { status: "sent" });
    expect(settleInterrupted(r)).toBe(r);
  });
});

describe("history", () => {
  it("keeps the newest first and caps it", () => {
    let runs: RunRecord[] = [];
    for (let i = 0; i < MAX_RUNS + 5; i++) runs = pushRun(runs, run(["Home"], `run-${i}`));
    expect(runs).toHaveLength(MAX_RUNS);
    expect(runs[0]!.id).toBe(`run-${MAX_RUNS + 4}`);
  });

  it("survives a round trip through clientStorage", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:2", { status: "failed", files: 5, error: "timed out" });
    const parsed = parseRuns(JSON.parse(JSON.stringify([r])));
    expect(parsed).toEqual([r]);
  });

  it("drops anything malformed instead of refusing to open", () => {
    const good = run(["Home"]);
    const parsed = parseRuns([
      null,
      "nope",
      { id: 7 },
      { id: "a", at: 1, frames: [] },
      { id: "b", at: 1, frames: [{ frameId: "1", name: "X", status: "exploded" }] },
      good,
    ]);
    expect(parsed).toEqual([good]);
    expect(parseRuns(undefined)).toEqual([]);
    expect(parseRuns({})).toEqual([]);
  });
});

describe("the Runs order", () => {
  it("puts what needs the designer first, then what is running, newest first within each", () => {
    const sent = (id: string, at: number): RunRecord => ({
      ...setFrame(run(["A"], id), "1:1", { status: "sent" }),
      at,
    });
    const failed = { ...setFrame(run(["B"], "failed"), "1:1", { status: "failed" }), at: 1 };
    const going = { ...run(["C"], "going"), at: 2 };

    const sorted = sortRuns([sent("new", 900), going, sent("old", 100), failed]);
    expect(sorted.map((r) => r.id)).toEqual(["failed", "going", "new", "old"]);
  });
});

describe("the words", () => {
  it("titles a run by its frames, trimming a long one", () => {
    expect(runTitle(run(["Home", "Fixtures", "Match centre"]))).toBe("Home · Fixtures · Match centre");
    expect(runTitle(run(["A", "B", "C", "D", "E"]))).toBe("A · B · C · +2");
  });

  it("says what went wrong in one sentence", () => {
    let r = run(["Home", "Fixtures"]);
    r = setFrame(r, "1:2", { status: "failed", error: "timed out" });
    expect(runProblem(r)).toBe("Fixtures: timed out");
    r = setFrame(r, "1:1", { status: "failed" });
    expect(runProblem(r)).toBe("2 frames didn’t make it. Home: didn’t finish uploading");
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
