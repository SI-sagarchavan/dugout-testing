import { randomUUID } from "node:crypto";
import type { RunEvent } from "@dugout/contracts";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  createThreadNotes,
  noteOf,
  renderThread,
  THREAD_BUDGET_TOKENS,
  type ThreadNote,
} from "../src/index.ts";

const usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  budgetCostUsd: 0,
  steps: 1,
};
let seq = 0;
const ev = (e: Omit<RunEvent, "runId" | "seq" | "at">): RunEvent =>
  ({ runId: "r1", seq: ++seq, at: "2026-11-07T10:00:00.000Z", ...e }) as RunEvent;
const child = { runId: "c1", agentId: "frame-match", parentRunId: "r1", callId: "call_1" };

describe("a run's note for its thread", () => {
  it("says what it made, what a person decided, what is open, and which children ran", () => {
    const note = noteOf({
      runId: "r1",
      agentId: "section-builder",
      input: { handoffId: "h1" },
      result: {
        status: "completed",
        output: {
          previewUrl: "http://p/preview/default/t2",
          planArtifactId: "plan-1",
          bound: 12,
          remaining: ["data: the count beside the icon has no field"],
        },
        usage,
      },
      events: [
        ev({
          type: "question.asked",
          data: {
            step: 1,
            callId: "q1",
            tool: "ask",
            from: ["c1"],
            questions: [
              {
                id: "layout",
                question: "Is the strip a carousel?",
                why: "",
                kind: "choice",
                options: [],
                allowOther: false,
                proposed: [],
              },
            ],
          },
        }),
        ev({
          type: "question.answered",
          data: {
            step: 1,
            callId: "q1",
            tool: "ask",
            by: "Asha",
            answers: { layout: "carousel" },
            source: "person",
          },
        }),
      ],
      childEvents: [
        {
          ...ev({
            type: "run.completed",
            data: {
              status: "completed",
              output: { previewUrl: "http://p/preview/default/t1", treeArtifactId: "t1" },
              usage,
            },
          }),
          child,
        },
      ],
      said: {
        did: "Built the section and bound it to data.",
        made: { previewUrl: "http://p/preview/default/t2", planArtifactId: "plan-1" },
        open: ["data: the count beside the icon has no field"],
      },
    });
    expect(note).toMatchObject({
      did: "Built the section and bound it to data.",
      // the run's own output wins a name a child also gave
      made: {
        previewUrl: "http://p/preview/default/t2",
        treeArtifactId: "t1",
        planArtifactId: "plan-1",
      },
      decided: ["Is the strip a carousel? → carousel (Asha)"],
      open: ["data: the count beside the icon has no field"],
      children: [{ agentId: "frame-match", status: "completed" }],
    });
  });

  it("keeps an output's one-word strings as made when the agent names none, and nothing open", () => {
    const note = noteOf({
      runId: "r3",
      agentId: "other",
      input: {},
      result: {
        status: "completed",
        output: {
          link: "http://p/x/1",
          summary: "a sentence is not a thing made",
          count: 3,
          remaining: ["not read: the agent did not say it is open"],
        },
        usage,
      },
      events: [],
      said: "Did it.",
    });
    expect(note).toMatchObject({ did: "Did it.", made: { link: "http://p/x/1" }, open: [] });
    expect(note.made.summary).toBeUndefined();
  });

  it("says why a run failed, and what it was on when the agent says nothing", () => {
    const note = noteOf({
      runId: "r2",
      agentId: "ui-editor",
      input: { preview: "http://p/preview/default/t2" },
      result: { status: "failed", reason: "error", message: "the preview is gone", usage },
      events: [],
    });
    expect(note.did).toBe("ui-editor failed on preview http://p/preview/default/t2");
    expect(note.open).toEqual(["failed (error): the preview is gone"]);
  });
});

describe("the thread as the next run reads it", () => {
  const note = (i: number, over: Partial<ThreadNote> = {}): ThreadNote => ({
    runId: `r${i}`,
    agentId: i === 0 ? "section-builder" : "ui-editor",
    status: "completed",
    at: `2026-11-07T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
    did: `run ${i} did its part`,
    made: { previewUrl: `http://p/preview/default/t${i}` },
    decided: [],
    open: [`open after run ${i}`],
    children: [],
    ...over,
  });

  it("gives where things stand, then what happened, newest first", () => {
    const text = renderThread([
      note(0, { made: { previewUrl: "p0", planArtifactId: "plan-0" } }),
      note(1),
    ]);
    expect(text).toContain("## This thread so far");
    // the latest of each thing made, and only what the last run left open
    expect(text).toContain("- previewUrl: http://p/preview/default/t1");
    expect(text).toContain("- planArtifactId: plan-0");
    expect(text).toContain("- open after run 1");
    expect(text).not.toContain("open after run 0");
    expect(text.indexOf("run 1 did")).toBeLessThan(text.indexOf("run 0 did"));
  });

  it("lists the section's versions newest first, and a person's newer version is what exists now", () => {
    const text = renderThread(
      [note(0, { made: { treeArtifactId: "t0" } }), note(1, { made: { treeArtifactId: "t1" } })],
      THREAD_BUDGET_TOKENS,
      [
        {
          tree: "t1",
          fromTree: "t0",
          by: "agent:ui-editor",
          what: 'row gap → "space.6"',
          restored: false,
          at: "2026-11-07T11:00:00.000Z",
        },
        {
          tree: "t0",
          fromTree: "t1",
          by: "A person",
          what: "Went back to v1",
          restored: true,
          at: "2026-11-07T12:00:00.000Z",
        },
      ],
    );
    expect(text).toContain("- treeArtifactId: t1");
    expect(text).toContain(
      "Newer than the last run: tree t0, A person, went back. It is what exists now",
    );
    const v3 = text.indexOf("- v3 tree t0 ← t1, A person, went back");
    const v2 = text.indexOf(
      '- v2 tree t1 ← t0, agent:ui-editor, 2026-11-07 11:00: row gap → "space.6"',
    );
    expect(v3).toBeGreaterThan(0);
    expect(v2).toBeGreaterThan(v3);
  });

  it("stays within its budget however long the thread gets: older runs a line each, then dropped", () => {
    const notes = Array.from({ length: 200 }, (_, i) =>
      note(i % 24, { runId: `r${i}`, did: `run ${i} ${"word ".repeat(40)}` }),
    );
    const text = renderThread(notes, THREAD_BUDGET_TOKENS);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(THREAD_BUDGET_TOKENS + 50);
    expect(text).toMatch(/…and \d+ earlier runs/);
    expect(renderThread([])).toBe("");
  });
});

describe("the thread's budget covers where things stand too", () => {
  it("counts what was made and left open against the budget, and says how much it left out", () => {
    const made = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `artifact${i}`,
        `http://p/preview/default/${"t".repeat(60)}${i}`,
      ]),
    );
    const text = renderThread(
      [
        {
          runId: "r1",
          agentId: "section-builder",
          status: "completed",
          at: "2026-11-07T10:00:00.000Z",
          did: "built the section",
          made,
          decided: [],
          open: Array.from({ length: 40 }, (_, i) => `open item ${i} ${"word ".repeat(20)}`),
          children: [],
        },
      ],
      THREAD_BUDGET_TOKENS,
    );
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(THREAD_BUDGET_TOKENS + 50);
    expect(text).toMatch(/…and \d+ more lines/);
    // what happened still has its place
    expect(text).toContain("built the section");
  });
});

describe("thread notes in the database", () => {
  const pool = createPool(inject("databaseUrl"));
  afterAll(() => pool.end());
  const threads = createThreadNotes(pool);
  const TENANT = "demo-cricket";

  it("finds a run's thread, keeps one note per run, and lists them oldest first", async () => {
    const runId = randomUUID();
    await withTenant(pool, TENANT, (db) =>
      db.query(
        `insert into runs (id, tenant_id, agent_id, status, input) values ($1, $2, 'section-builder', 'completed', $3)`,
        [runId, TENANT, { handoffId: randomUUID() }],
      ),
    );
    const threadId = await threads.threadOf(TENANT, runId);
    expect(threadId).toBeDefined();
    const n = noteOf({
      runId,
      agentId: "section-builder",
      input: {},
      result: { status: "completed", output: {}, usage },
      events: [],
    });
    await threads.add(TENANT, threadId as string, n);
    await threads.add(TENANT, threadId as string, { ...n, did: "said again" });
    expect((await threads.list(TENANT, threadId as string)).map((x) => x.did)).toEqual([
      "said again",
    ]);
    // another tenant sees none of it
    expect(await threads.threadOf("demo-football", runId)).toBeUndefined();
    expect(await threads.list("demo-football", threadId as string)).toEqual([]);
  });
});
