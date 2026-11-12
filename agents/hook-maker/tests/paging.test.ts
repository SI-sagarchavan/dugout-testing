import { describe, expect, it } from "vitest";
import { pagingIssues } from "../src/agent.ts";
import { pagingEvidence } from "../src/evidence.ts";

/** A list the design pages through (LOAD MORE): the page reads where it stands at `next`. */
describe("a paged need", () => {
  it("refuses an output that cannot say where the list stands", () => {
    // run 8d607f32: hook-maker reused an unpaged hook, and interaction could not wire LOAD MORE
    expect(pagingIssues(true, { galleries: [{ id: 1 }] })[0]).toMatch(/has no next at its top/);
    expect(pagingIssues(true, { galleries: [], next: null })).toEqual([]);
    expect(pagingIssues(true, { galleries: [], next: 2 })).toEqual([]);
    expect(pagingIssues(undefined, { galleries: [] })).toEqual([]);
  });

  it("shows what the output answers at next, and nothing for a need that is not paged", () => {
    expect(pagingEvidence(true, { galleries: [], next: 2 })).toMatchObject({ next: 2 });
    expect(pagingEvidence(true, { galleries: [] })?.next).toMatch(/no next/);
    expect(pagingEvidence(false, { next: 2 })).toBeUndefined();
  });
});
