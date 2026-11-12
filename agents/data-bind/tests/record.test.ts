import type { RunEvent } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { record } from "../src/record.ts";

const section = { section: "sig-fixtures", name: "Fixtures strip" };
const PLAN = {
  note: "fixtures",
  collapse: [
    {
      over: "fixtures.matches",
      as: "match",
      members: ["1:2", "1:3"],
      fields: [
        { src: "1:4", prop: "content", path: 'match.start | date:"DD MMM"' },
        { src: "1:5", prop: "content", template: "({match.overs} ov)" },
      ],
      variants: [{ src: "1:9", when: { path: "match.live", eq: true }, fields: [] }],
    },
  ],
  bind: [{ src: "1:1", prop: "content", path: "fixtures.title" }],
  keep: [{ src: "1:0", why: "the section's heading" }],
};

/** A run that tried one plan bind.try refused and one it applied. */
function tried(...plans: Array<{ plan: unknown; ok: boolean }>): RunEvent[] {
  return plans.flatMap(({ plan, ok }, i) => {
    const call = { step: i, callId: `c${i}`, tool: "bind.try" };
    return [
      { type: "tool.started", data: { ...call, input: { plan: JSON.stringify(plan) } } },
      { type: "tool.completed", data: { ...call, ok, content: "{}", durationMs: 1 } },
    ] as unknown as RunEvent[];
  });
}

describe("data-bind's build record (ADR 0034)", () => {
  it("says what was bound, from the result and the last plan bind.try applied", () => {
    const report = record({
      section,
      events: tried({ plan: PLAN, ok: true }, { plan: { note: "refused" }, ok: false }),
      output: {
        previewUrl: "http://localhost:3000/preview/default/t",
        planArtifactId: "plan-1",
        bound: 3,
        collapsed: 1,
        remaining: [],
        data: "bound",
        sources: [
          { kind: "cast-hook", hookId: "dugout_fixtures", input: { team: "7" }, as: "fixtures" },
        ],
      },
    });
    expect(report).toMatchObject({
      good: true,
      line: 'bound "Fixtures strip" to dugout_fixtures: 3 props, 1 lists',
      previewUrl: "http://localhost:3000/preview/default/t",
      did: {
        ending: "bound",
        planArtifactId: "plan-1",
        sources: [{ as: "fixtures", hookId: "dugout_fixtures", input: { team: "7" } }],
        plan: { note: "fixtures", keep: PLAN.keep },
        forms: ['match.start | date:"DD MMM"', "({match.overs} ov)"],
      },
    });
    // nothing of the club's in the portable part: no node id, hook id, input or data path
    const portable = JSON.stringify(report?.portable);
    for (const own of ["1:2", "dugout_fixtures", "match.start", "fixtures.title"]) {
      expect(portable).not.toContain(own);
    }
    expect(report?.portable).toMatchObject({
      lists: [{ members: 2, props: ["content", "content"], variants: 1 }],
      kept: ["the section's heading"],
    });
  });

  it("is not good when published despite problems or on stand-in data", () => {
    const base = { bound: 1, collapsed: 0, remaining: ["a date in another form"] };
    expect(
      record({ section, events: [], output: { ...base, data: "bound", despite: "cannot fix" } })
        ?.good,
    ).toBe(false);
    const standIn = record({
      section,
      events: [],
      output: { ...base, data: "stand-in", dataWhy: "about another team" },
    });
    expect(standIn).toMatchObject({ good: false, remaining: ["a date in another form"] });
    expect(standIn?.line).toContain("stand-in data");
  });

  it("is good when nothing on the section is data, and silent when the run did nothing", () => {
    expect(record({ section, events: [], output: { static: true, data: "none" } })).toMatchObject({
      good: true,
      line: 'left "Fixtures strip" unbound',
    });
    expect(record({ section, events: [], output: undefined })).toBeUndefined();
    // no source found and nobody decided: not good, so it is never read as a precedent
    expect(
      record({ section, events: [], output: { data: "none", dataWhy: "no hook" } })?.good,
    ).toBe(false);
    const call = { step: 1, callId: "c1", tool: "ask" };
    const answered = (source: string, answer: string) =>
      [
        {
          type: "question.answered",
          data: { ...call, by: "x", source, answers: { data_source: answer } },
        },
      ] as unknown as RunEvent[];
    const none = { data: "none" as const, dataWhy: "no hook" };
    // a person answered none when the model asked
    expect(record({ section, events: answered("person", "none"), output: none })?.good).toBe(true);
    // an auto answer, or another answer, is no one's decision to leave it unbound
    expect(record({ section, events: answered("auto", "none"), output: none })?.good).toBe(false);
    expect(record({ section, events: answered("person", "find_hook"), output: none })?.good).toBe(
      false,
    );
    // a person's earlier decision on this section, as bind.load returned it
    const loaded = [
      {
        type: "tool.completed",
        data: {
          step: 1,
          callId: "l1",
          tool: "bind.load",
          ok: true,
          content: JSON.stringify({ settled: { data_source: "none" } }),
          durationMs: 1,
        },
      },
    ] as unknown as RunEvent[];
    expect(record({ section, events: loaded, output: none })?.good).toBe(true);
    // a run that failed after a plan was applied still says what it tried
    expect(
      record({ section, events: tried({ plan: PLAN, ok: true }), output: undefined }),
    ).toMatchObject({ good: false, did: { ending: "unpublished" } });
  });

  it("proposes the form each kind of date was written in, from the date pipes the plan named", () => {
    const report = record({
      section,
      events: tried({ plan: PLAN, ok: true }),
      output: { bound: 3, collapsed: 1, remaining: [], data: "bound", sources: [] },
    });
    expect(report?.patterns).toEqual([
      {
        key: "form.date.start",
        value: { pipe: 'date:"DD MMM"', field: "start" },
        sentence: 'A start is written with the pipe date:"DD MMM"',
      },
    ]);
    const plain = { ...PLAN, collapse: [], bind: [{ src: "1:1", prop: "content", path: "a.b" }] };
    const none = record({ section, events: tried({ plan: plain, ok: true }), output: undefined });
    expect(none?.patterns).toBeUndefined();
  });
});
