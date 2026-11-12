import type { RunEvent } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { record } from "../src/record.ts";
import { MAX_PUBLISH_REFUSALS } from "../src/tools.ts";

const section = { section: "sig-hero", name: "Hero" };

/** A call of one tool with what it answered. */
function call(n: number, tool: string, input: unknown, result: unknown): RunEvent[] {
  const ids = { step: n, callId: `c${n}`, tool };
  return [
    { type: "tool.started", data: { ...ids, input } },
    {
      type: "tool.completed",
      data: { ...ids, ok: true, content: JSON.stringify(result), durationMs: 1 },
    },
  ] as unknown as RunEvent[];
}
const refused = (n: number) =>
  ({
    type: "tool.denied",
    data: {
      step: n,
      callId: `d${n}`,
      tool: "frame.publish",
      stage: "policy",
      reason: "not yet",
      advisory: true,
    },
  }) as unknown as RunEvent;

const EVENTS = [
  ...call(1, "frame.override", { crops: ["1:2"] }, { kept: true, was: 81.5, match: 97.25 }),
  ...call(
    2,
    "frame.override",
    { props: [{ src: "1:3", props: {} }] },
    { kept: false, reason: "dropped" },
  ),
  ...call(
    3,
    "frame.layout",
    {
      choice: { src: "1:9", kind: "carousel", config: { pages: 3 } },
      settled: [{ id: "kind", by: "person" }],
    },
    { kept: true },
  ),
];
const OUTPUT = {
  previewUrl: "http://localhost:3000/preview/default/t",
  measured: true,
  coverage: 100,
  before: 81.5,
  match: 97.25,
  remaining: ["a gradient with no token"],
  compilerFindings: ["crop the logo"],
};
const run = (output: unknown, events = EVENTS) => ({
  input: { handoffId: "h-1" },
  output,
  events,
  section,
});

describe("frame-match's build record (ADR 0034)", () => {
  it("keeps the overrides that helped with what each gained, and each layout as applied", () => {
    const report = record(run(OUTPUT));
    expect(report).toMatchObject({
      good: true,
      score: 97.25,
      handoffId: "h-1",
      section: { layout: "carousel" },
      remaining: ["a gradient with no token"],
      line: 'matched "Hero" at 97.25% (81.5% compiled): 1 overrides kept, carousel',
      did: {
        overrides: [{ change: { crops: ["1:2"] }, gained: 15.75 }],
        layouts: [
          { choice: { src: "1:9", kind: "carousel" }, settled: [{ id: "kind", by: "person" }] },
        ],
        before: 81.5,
        match: 97.25,
        compilerFindings: ["crop the logo"],
      },
    });
    expect(JSON.stringify(report?.portable)).not.toContain("1:");
    expect(report?.portable).toMatchObject({
      layouts: ["carousel"],
      overrides: [{ kinds: ["crops"], gained: 15.75 }],
    });
  });

  it("is not good below the compile, unmeasured, or let through after the refusals ran out", () => {
    expect(record(run({ ...OUTPUT, match: 70 }))?.good).toBe(false);
    expect(record(run({ ...OUTPUT, measured: false, match: undefined }))).toMatchObject({
      good: false,
      line: 'matched "Hero", not measured: 1 overrides kept, carousel',
    });
    const forced = [
      ...EVENTS,
      ...Array.from({ length: MAX_PUBLISH_REFUSALS }, (_, i) => refused(10 + i)),
    ];
    expect(record(run(OUTPUT, forced))).toMatchObject({ good: false, did: { forced: true } });
  });

  it("says what a failed run tried, and nothing for a run that did nothing", () => {
    expect(record(run(undefined))).toMatchObject({
      good: false,
      line: 'worked on "Hero" and did not publish',
    });
    expect(record(run(undefined, []))).toBeUndefined();
  });

  it("proposes the layout of a section of one kind, named for the list the section shows", () => {
    expect(record(run(OUTPUT))?.patterns).toEqual([
      {
        key: "layout.{list}",
        value: { layout: "carousel", list: "{list}" },
        sentence: 'A section that shows the list "{list}" is a carousel',
      },
    ]);
    const grid = call(4, "frame.layout", { choice: { src: "1:8", kind: "grid" } }, { kept: true });
    expect(record(run(OUTPUT, [...EVENTS, ...grid]))?.patterns).toBeUndefined();
    expect(record(run(OUTPUT, EVENTS.slice(0, 4)))?.patterns).toBeUndefined();
  });
});
