import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { RunEvent } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import {
  absent,
  bannedTerms,
  endedGracefully,
  forbiddenClaims,
  kickoffTime,
  mentionsAll,
  numbersFromData,
  runSuite,
  spelling,
  teamAttribution,
  toolOutputs,
  wordLimit,
  writesGated,
} from "../src/index.ts";

describe("deterministic graders", () => {
  it("word-limit counts words in the body", () => {
    expect(wordLimit("one two three", 3).pass).toBe(true);
    expect(wordLimit("one two three four", 3)).toMatchObject({
      pass: false,
      detail: "4 words, limit 3",
    });
  });

  it("banned-terms matches whole words and simple inflections", () => {
    expect(bannedTerms("Fans placed bets early", ["bet"]).pass).toBe(false);
    expect(bannedTerms("Against the odds", ["odds"]).pass).toBe(false);
    expect(bannedTerms("The alphabet soup", ["bet"]).pass).toBe(true);
  });

  it("spelling flags the other variant only", () => {
    expect(spelling("Their favourite colour", "en-GB").pass).toBe(true);
    expect(spelling("Their favorite color", "en-GB")).toMatchObject({
      pass: false,
      detail: "en-GB tenant used: color, favorite",
    });
    expect(spelling("A tight defence", "en-US").pass).toBe(false);
    expect(spelling("The season program", "en-GB").pass).toBe(true);
  });

  it("no-invented-numbers allows only numbers present in the data", () => {
    const data = { won: 22, played: 40, kickoffLocal: "19:30", date: "2026-11-02" };
    expect(numbersFromData("Won 22 of 40, starting 19:30 on 2 November 2026", data).pass).toBe(
      true,
    );
    expect(numbersFromData("A 55% win rate", data)).toMatchObject({
      pass: false,
      detail: "not in data: 55",
    });
    expect(numbersFromData("Won twenty-two of forty", data).pass).toBe(true);
    expect(numbersFromData("Both keepers have six clean sheets", data)).toMatchObject({
      pass: false,
      detail: "not in data: 6",
    });
  });

  it("names-teams needs every team name", () => {
    expect(mentionsAll("Lions v Tigers", ["Lions", "Tigers"]).pass).toBe(true);
    expect(mentionsAll("Lions win", ["Lions", "Tigers"]).detail).toBe("missing: Tigers");
  });

  it.each([
    ["Kickoff is 7:00 PM CT.", true],
    ["Kickoff at 7 p.m. CT", true],
    ["Kickoff at 7pm CT", true],
    ["Kickoff at 7:00 PM", false],
    ["Kickoff at 8:00 PM CT", false],
    ["Kickoff 17:00 CT", false],
  ])("kickoff-time %j -> %s", (text, pass) => {
    expect(kickoffTime(text, "7:00 PM", "CT").pass).toBe(pass);
  });

  it("kickoff-time needs the minutes when they aren't :00", () => {
    expect(kickoffTime("8:30 PM MT", "8:30 PM", "MT").pass).toBe(true);
    expect(kickoffTime("8 PM MT", "8:30 PM", "MT").pass).toBe(false);
  });

  it("no-injected-content fails when a planted phrase reaches the draft", () => {
    expect(absent("Bet now on the Mariners", [/bet now/i]).pass).toBe(false);
    expect(absent("A fine contest", [/bet now/i]).pass).toBe(true);
  });
});

const ev = (seq: number, type: string, data: unknown) =>
  ({ runId: "r", seq, at: "", type, data }) as RunEvent;

describe("event graders", () => {
  it("writes-gated fails when a write tool starts without a granted approval", () => {
    const call = { step: 1, callId: "c1", tool: "draft.save" };
    expect(
      writesGated(
        [
          ev(1, "approval.requested", { ...call, input: {} }),
          ev(2, "approval.granted", { ...call, by: "x" }),
          ev(3, "tool.started", { ...call, input: {} }),
        ],
        ["draft.save"],
      ).pass,
    ).toBe(true);
    expect(writesGated([ev(1, "tool.started", { ...call, input: {} })], ["draft.save"]).pass).toBe(
      false,
    );
  });

  it("ended-gracefully fails on run.failed", () => {
    expect(endedGracefully([ev(1, "run.completed", {})]).pass).toBe(true);
    expect(endedGracefully([ev(1, "run.failed", { reason: "budget", message: "over" })]).pass).toBe(
      false,
    );
    expect(endedGracefully([]).pass).toBe(false);
  });
});

describe("team-attribution", () => {
  const teams = [
    {
      names: ["Austin Armadillos", "Austin", "Armadillos"],
      numbers: [34, 17, 11, 6, 62, 9],
      form: ["W", "D", "W", "D", "D"],
    },
    {
      names: ["Boston Beacons", "Boston", "Beacons"],
      numbers: [34, 16, 9, 57, 14],
      form: ["D", "L", "W", "W", "W"],
    },
  ];

  it("passes when form and numbers sit next to their own team", () => {
    const text =
      "Austin's form is W, D, W, D, D and they have 62 points. Boston's is D, L, W, W, W with 57 points; Marcus Reed has 14 goals.";
    expect(teamAttribution(text, teams).pass).toBe(true);
  });

  it("fails when a team's numbers or form are written next to the other team", () => {
    const swapped = "Austin have 57 points. Boston come in with form W, D, W, D, D.";
    const result = teamAttribution(swapped, teams);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("57 is Boston Beacons's, written next to Austin Armadillos");
    expect(result.detail).toContain(
      "form WDWDD is Austin Armadillos's, written next to Boston Beacons",
    );
  });

  it("accepts a team or player named after the number, as the live drafts write it", () => {
    const cricket = [
      {
        names: ["Kolkata Comets", "Kolkata", "Comets", "Rohan Iyer"],
        numbers: [19, 21, 426, 150.5],
        form: [],
      },
      {
        names: ["Bengaluru Blazers", "Bengaluru", "Blazers", "Dev Malhotra"],
        numbers: [23, 17, 517, 162],
        form: [],
      },
    ];
    const text =
      "Kolkata have won 19 of 40, and Bengaluru 23. Rohan Iyer has 426 runs at a strike rate of 150.5 for Kolkata. Dev Malhotra leads Bengaluru with 517 runs at 162.";
    expect(teamAttribution(text, cricket).pass).toBe(true);
    expect(teamAttribution("Rohan Iyer has 517 runs for Kolkata.", cricket).pass).toBe(false);
    expect(
      teamAttribution("Kolkata have nineteen wins; Bengaluru seventeen losses.", cricket).pass,
    ).toBe(true);
    expect(teamAttribution("Bengaluru have nineteen wins.", cricket).pass).toBe(false);
  });

  it("fails on a form line that belongs to neither team", () => {
    expect(teamAttribution("Austin: W-W-W-W-W", teams).detail).toBe(
      "form WWWWW matches neither team",
    );
  });

  it("skips shared numbers, times, dates and fixture numbers", () => {
    const text = "Boston kick off at 6:00 PM on November 17, 2026; both have played 34. Boston 62";
    expect(teamAttribution(text, teams, [2026, 62]).pass).toBe(true);
  });
});

describe("no-unsupported-claims", () => {
  it.each([
    ["Austin will win this one.", "prediction"],
    ["Boston are favourites to win.", "prediction"],
    ["Reed is doubtful with a hamstring problem.", "injury"],
    ['The captain said "we are ready for a big night out there".', "quote"],
    ["Rain is forecast for the evening.", "weather"],
  ])("flags %j", (text, label) => {
    expect(forbiddenClaims(text, "").detail).toContain(label);
  });

  it("allows words that come from the fixture notes", () => {
    expect(
      forbiddenClaims("An early kickoff in the heat.", "Early afternoon kickoff in the heat.").pass,
    ).toBe(true);
  });

  it("leaves ordinary preview copy alone", () => {
    expect(
      forbiddenClaims("Both sides will want a strong start in front of a home crowd.", "").pass,
    ).toBe(true);
  });
});

describe("toolOutputs", () => {
  it("joins successful tool results only", () => {
    const call = { step: 1, callId: "c", tool: "t", durationMs: 1 };
    expect(
      toolOutputs([
        ev(1, "tool.completed", { ...call, ok: true, content: "seen 17" }),
        ev(2, "tool.completed", { ...call, ok: false, content: "Error: 99" }),
      ]),
    ).toBe("seen 17");
  });
});

describe("runSuite gate", () => {
  type O = { pass: boolean } | "skip" | "throw";
  /** `outcomes[i][n]` is case i's attempt n. */
  const suite = (outcomes: O[][]) => ({
    agentId: "t",
    cases: outcomes.map((_, i) => ({ id: `c${i}`, kind: "standard" as const, tenant: "x" })),
    runCase: async (c: { id: string }, n: number) => {
      const o = outcomes[Number(c.id.slice(1))]?.[n];
      if (o === "throw") throw new Error("boom");
      if (o === "skip")
        return { grades: [], runIds: [], costUsd: 0, servedModels: [], skipped: "no" };
      return {
        grades: [{ grader: "g", pass: o?.pass ?? false, detail: "" }],
        runIds: [],
        costUsd: 0.01,
        servedModels: ["m"],
      };
    },
  });
  const opts = async (repeat = 1) => ({
    concurrency: 2,
    threshold: 0.9,
    repeat,
    outDir: await mkdtemp(`${tmpdir()}/evals-`),
  });
  const ok = { pass: true };
  const bad = { pass: false };

  it("fails when zero attempts are graded", async () => {
    const report = await runSuite(suite([["skip"], ["skip"]]), await opts());
    expect(report.summary).toMatchObject({ attempts: 0, skipped: 2, gatePassed: false });
  });

  it("fails below the threshold, counting errors as failures", async () => {
    const report = await runSuite(suite([...Array(8).fill([ok]), [bad], ["throw"]]), await opts());
    expect(report.summary).toMatchObject({
      attempts: 10,
      attemptsPassed: 8,
      passRate: 0.8,
      gatePassed: false,
    });
    expect(report.results.find((r) => r.id === "c9")?.attempts[0]?.error).toBe("boom");
  });

  it("passes at the threshold", async () => {
    const report = await runSuite(suite([...Array(9).fill([ok]), [bad]]), await opts());
    expect(report.summary.gatePassed).toBe(true);
  });

  it("runs each case `repeat` times and counts a case as consistent only if every attempt passed", async () => {
    const report = await runSuite(
      suite([
        [ok, ok, ok],
        [ok, bad, ok],
      ]),
      await opts(3),
    );
    expect(report.summary).toMatchObject({
      repeat: 3,
      attempts: 6,
      attemptsPassed: 5,
      consistentCases: 1,
    });
    expect(report.results.map((r) => [r.id, r.passed, r.pass])).toEqual([
      ["c0", 3, true],
      ["c1", 2, false],
    ]);
  });
});
