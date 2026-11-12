import { describe, expect, it } from "vitest";
import { record } from "../src/record.ts";

const section = { section: "sig-fixtures", name: "Fixtures strip" };
const need = {
  list: "fixtures",
  count: 4,
  item: [
    { field: "score", required: true },
    { field: "venue", required: false },
  ],
  must: { team: "Southern Brave" },
};
const answer = {
  hookId: "dugout_fixtures",
  built: false,
  input: { team: "7" },
  covers: ["score → matches[].teams[0].score"],
  missing: ["venue"],
  why: "the only hook with scores",
  basis: "found",
};
const run = (output: unknown, input: unknown = { need }) => ({
  input,
  output,
  events: [],
  section,
});

describe("hook-maker's build record (ADR 0034)", () => {
  it("is good when the hook gives every field the design cannot do without", () => {
    const report = record(run(answer));
    expect(report).toMatchObject({
      good: true,
      line: 'found dugout_fixtures for "Fixtures strip" (fixtures)',
      remaining: ["venue"],
      did: { hookId: "dugout_fixtures", basis: "found", input: { team: "7" } },
    });
    const portable = JSON.stringify(report?.portable);
    for (const own of ["dugout_fixtures", "Southern Brave", "matches[]"]) {
      expect(portable).not.toContain(own);
    }
  });

  it("is good with a working hook that lacks a field, not good about another team or with no hook", () => {
    // what the feed does not give is remaining, not a failure: the hook is still the section's
    expect(record(run({ ...answer, covers: [] }))).toMatchObject({
      good: true,
      remaining: ["the hook does not give score, which the design needs", "venue"],
    });
    const other = { ...answer, about: { reading: "other", why: "it names Trent Rockets" } };
    expect(record(run(other))?.good).toBe(false);
    expect(record(run(other))?.did).toMatchObject({ about: { reading: "other" } });
    // the model's reading, not the words of missing, says what the data is about
    const said = { ...answer, about: { reading: "design", why: "it names Southern Brave" } };
    const prose = { ...said, missing: ["the data is about Trent Rockets, not Southern Brave"] };
    expect(record(run(prose))?.good).toBe(true);
    expect(record(run({ ...said, about: { reading: "unknown", why: "no names" } }))?.good).toBe(
      true,
    );
    // an answer made before about: its missing lines, as then
    const old = { ...answer, missing: ["the data is about Trent Rockets, not Southern Brave"] };
    expect(record(run(old))?.good).toBe(false);
    expect(record(run({ ...answer, hookId: null }))).toMatchObject({
      good: false,
      line: 'found no hook for "Fixtures strip" (fixtures)',
    });
  });

  it("records a failed run by its need, and nothing for a run with no need", () => {
    expect(record(run(undefined))).toMatchObject({
      good: false,
      did: { need: { list: "fixtures" } },
    });
    expect(record(run(answer, {}))).toBeUndefined();
  });

  it("names the section's list, and proposes the hook that fed it once sections agree", () => {
    const report = record(run(answer));
    expect(report?.section).toEqual({ labels: { list: "fixtures" } });
    expect(report?.patterns).toEqual([
      {
        key: "data.hook.{list}",
        value: { hook: "dugout_fixtures", list: "{list}" },
        sentence: 'The hook dugout_fixtures feeds the list "{list}"',
      },
    ]);
    // no hook, no pattern; the list is named all the same, for other agents' patterns
    const none = record(run({ ...answer, hookId: null }));
    expect(none?.patterns).toBeUndefined();
    expect(none?.section?.labels).toEqual({ list: "fixtures" });
    expect(record(run(undefined))?.section?.labels).toEqual({ list: "fixtures" });
  });
});
