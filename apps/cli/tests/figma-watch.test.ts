import type { RunEvent } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { createFigmaWatch, finishedLines } from "../src/figma-watch.ts";
import { shower, type Terminal } from "../src/session.ts";

const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const sent = (id: string, minute: number, rootNodeId = `root-${id}`) => ({
  id,
  fileKey: "file",
  rootNodeId,
  rootName: id,
  irArtifactId: "ir",
  plates: [],
  receivedAt: at(minute),
});

function setup(opts: { exports: ReturnType<typeof sent>[]; prior?: unknown[]; since?: number }) {
  const started: string[] = [];
  const watch = createFigmaWatch({
    project: "default",
    since: new Date(at(opts.since ?? 0)),
    listExports: async () => opts.exports,
    priorRuns: async () => (opts.prior ?? []).map((input) => ({ input })),
    start: async (input) => {
      started.push(input.exportId);
      return `run-${input.exportId}`;
    },
  });
  return { watch, started };
}

describe("createFigmaWatch", () => {
  it("queues one run for each new Send, oldest first", async () => {
    const { watch, started } = setup({ exports: [sent("b", 5), sent("a", 3)] });
    expect((await watch.look()).map((run) => run.runId)).toEqual(["run-a", "run-b"]);
    expect(started).toEqual(["a", "b"]);
  });

  it("does not run an export twice", async () => {
    const { watch, started } = setup({ exports: [sent("a", 3)] });
    await watch.look();
    await watch.look();
    expect(started).toEqual(["a"]);
  });

  it("leaves exports from before it started", async () => {
    const { watch, started } = setup({ exports: [sent("old", 3)], since: 10 });
    await watch.look();
    expect(started).toEqual([]);
  });

  it("runs only the newest Send of one frame", async () => {
    const { watch, started } = setup({ exports: [sent("v2", 6, "frame"), sent("v1", 5, "frame")] });
    await watch.look();
    expect(started).toEqual(["v2"]);
  });

  it("picks up what was sent while it was down, without repeating a run", async () => {
    const { watch, started } = setup({
      exports: [sent("gap", 7), sent("done", 5)],
      prior: [{ exportId: "done", receivedAt: at(5) }],
      since: 30,
    });
    await watch.look();
    expect(started).toEqual(["gap"]);
  });
});

describe("finishedLines", () => {
  const usage = { costUsd: 0.09, steps: 15 };

  it("ends a published run with the preview link and what is left", () => {
    const text = finishedLines(
      {
        type: "run.completed",
        data: {
          status: "completed",
          usage,
          output: {
            previewUrl: "http://studio/v1/preview/x",
            before: 81.83,
            match: 98.03,
            remaining: ["title is 2px off"],
            compilerFindings: [],
          },
        },
      },
      "run-1",
    ).join("\n");
    expect(text).toContain("FINISHED: matched 81.83% → 98.03%");
    expect(text).toContain("preview: http://studio/v1/preview/x");
    expect(text).toContain("still off: title is 2px off");
  });

  it("labels a frame published with nothing compared", () => {
    const text = finishedLines(
      {
        type: "run.completed",
        data: {
          status: "completed",
          usage,
          output: {
            previewUrl: "http://studio/v1/preview/y",
            measured: false,
            unmeasuredBecause: "too tall",
            placeholderIcons: 18,
            remaining: [],
            compilerFindings: [],
          },
        },
      },
      "run-2",
    ).join("\n");
    expect(text).toContain("FINISHED: published UNMEASURED");
    expect(text).toContain("why: too tall");
    expect(text).toContain("logos and icons with no art: 18");
    expect(text).toContain("preview: http://studio/v1/preview/y");
  });

  it("says when a run failed", () => {
    expect(
      finishedLines({ type: "run.failed", data: { message: "budget", usage } }, "r").join("\n"),
    ).toContain("FINISHED: failed");
  });
});

describe("shower", () => {
  const events = (...list: Array<[string, Record<string, unknown>]>) =>
    list.map(([type, data]) => ({ type, data }) as unknown as RunEvent);

  it("gives each call of a turn its own line and doesn't print it again", () => {
    const out: string[] = [];
    const show = shower({
      write: (text: string) => out.push(text),
      line: (text: string) => out.push(`${text}\n`),
    } as unknown as Terminal);
    const delta = (callId: string, text: string): [string, Record<string, unknown>] => [
      "tool.input.delta",
      { step: 1, index: 0, callId, tool: "frame.node", text },
    ];
    const started = (callId: string, src: string): [string, Record<string, unknown>] => [
      "tool.started",
      { step: 1, callId, tool: "frame.node", input: { src } },
    ];
    for (const event of events(
      delta("a", '{"src":"A"}'),
      delta("b", '{"src":"B"}'),
      started("a", "A"),
      started("b", "B"),
    )) {
      show(event);
    }
    const text = out.join("");
    expect(text).not.toContain('"A"}{');
    expect(text.match(/"src":"B"/g)).toHaveLength(1);
  });

  it("says why a final was refused", () => {
    const out: string[] = [];
    const show = shower({
      write: (text: string) => out.push(text),
      line: (text: string) => out.push(`${text}\n`),
    } as unknown as Terminal);
    for (const event of events(["final.refused", { step: 1, callId: "c", reason: "not that" }])) {
      show(event);
    }
    expect(out.join("")).toContain("final refused: not that");
  });
});
