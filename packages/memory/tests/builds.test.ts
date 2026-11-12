import { randomUUID } from "node:crypto";
import {
  AUTO_APPROVED,
  type BuildPattern,
  type BuildRecord,
  type RunEvent,
} from "@dugout/contracts";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  type BuildReporter,
  buildContext,
  buildKey,
  builtFor,
  consolidateRun,
  createHashEmbeddings,
  createMemoryStore,
  createMemoryTools,
  factsNote,
  type MemoryStore,
  patternsFor,
  patternsOf,
  proposePatterns,
  recordCorrections,
  resolvePattern,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store: MemoryStore = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

let tenant: string;
beforeEach(() => {
  tenant = `t-build-${randomUUID().slice(0, 8)}`;
});

const AGENT = "data-bind";
const SECTION = "sig-fixtures-strip";
const USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0.12, budgetCostUsd: 0.12, steps: 2 };

/** A run that loaded a section, published with a write someone approved, and ended. */
function runEvents(
  runId: string,
  over: { by?: string; ending?: "completed" | "failed"; situated?: boolean } = {},
): RunEvent[] {
  let seq = 0;
  const ev = (type: string, data: unknown) =>
    ({ runId, seq: ++seq, at: "2026-11-10T09:00:00Z", type, data }) as RunEvent;
  const call = { step: 1, callId: "c1", tool: "bind.publish" };
  return [
    ev("run.started", {
      agentId: AGENT,
      agentVersion: 3,
      tenantId: tenant,
      input: { preview: "p" },
    }),
    ev("step.completed", {}),
    ev("tool.completed", {
      step: 1,
      callId: "c0",
      tool: "bind.load",
      ok: true,
      content: "{}",
      durationMs: 1,
      ...(over.situated === false
        ? {}
        : { situation: { section: SECTION, name: "Fixtures strip" } }),
    }),
    ev("question.asked", { ...call, questions: [], from: [], subject: { input: {} } }),
    ev("question.answered", {
      ...call,
      by: over.by ?? "sam",
      answers: { review: { decision: "approve" } },
      source: "person",
    }),
    ev("step.completed", {}),
    over.ending === "failed"
      ? ev("run.failed", { reason: "max_steps", message: "out of steps", usage: USAGE })
      : ev("run.completed", { status: "completed", output: { bound: 14 }, usage: USAGE }),
  ];
}

const report =
  (did: unknown, good = true): BuildReporter =>
  ({ output }) => ({
    did,
    good,
    line: 'bound "Fixtures strip" to dugout_fixtures, mail sam@example.com',
    remaining: good ? [] : ["the date is not in the design's form"],
    ...(output ? { previewUrl: "http://localhost:3000/preview/default/t" } : {}),
  });

const consolidate = (runId: string, record: BuildReporter, events = runEvents(runId)) =>
  consolidateRun({ writer: store, tenantId: tenant, agentId: AGENT, runId, events, record });

/** A memory tool by name, called with whatever the test passes. */
const memoryTool = (name: string) => {
  const tool = createMemoryTools({ reader: store }).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool as unknown as { run(input: unknown, ctx: unknown): Promise<unknown> };
};

const recordOf = (item: { value: unknown } | undefined) => item?.value as BuildRecord;

describe("build records (ADR 0034)", () => {
  it("keeps what a run built on its section, with the outcome read from the events", async () => {
    const runId = randomUUID();
    const out = await consolidate(runId, report({ hook: "dugout_fixtures" }));
    expect(out.episodes).toEqual([]); // the record is the example
    expect(out.build).toMatchObject({
      episodeType: "build",
      key: buildKey(AGENT, SECTION),
      content:
        '2026-11-10 data-bind bound "Fixtures strip" to dugout_fixtures, mail [REDACTED:email]: good in 2 steps.',
    });
    const record = out.build?.value as BuildRecord;
    expect(record).toMatchObject({
      v: 1,
      agent: AGENT,
      agentVersion: 3,
      section: { signature: SECTION, name: "Fixtures strip" },
      run: { runId, previewUrl: "http://localhost:3000/preview/default/t" },
      did: { hook: "dugout_fixtures" },
      outcome: {
        ended: "completed",
        good: true,
        remaining: [],
        steps: 2,
        costUsd: 0.12,
        asked: 0,
        approvedBy: "person",
      },
    });
  });

  it("records a run nobody approved by hand, and a run that failed as not good", async () => {
    const auto = await consolidate(
      randomUUID(),
      report({ hook: "a" }),
      runEvents(randomUUID(), { by: `sam${AUTO_APPROVED}` }),
    );
    expect(recordOf(auto.build).outcome.approvedBy).toBe("auto");
    const failed = await consolidate(
      randomUUID(),
      report({ hook: "b" }),
      runEvents(randomUUID(), { ending: "failed" }),
    );
    expect(recordOf(failed.build).outcome).toMatchObject({
      ended: "failed",
      good: false,
    });
    expect(failed.build?.content).toContain(": failed.");
  });

  it("leaves none for a run with no section, or one the agent has nothing to say about", async () => {
    const unsituated = await consolidate(
      randomUUID(),
      report({}),
      runEvents(randomUUID(), { situated: false }),
    );
    expect(unsituated.build).toBeUndefined();
    const silent = await consolidate(randomUUID(), () => undefined);
    expect(silent.build).toBeUndefined();
    expect(await store.builds(tenant)).toEqual([]);
  });

  it("strengthens the same work, adds different work, and keeps one failure per key", async () => {
    const first = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    const again = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    expect(again.build).toMatchObject({ id: first.build?.id, strength: 2 });
    await consolidate(randomUUID(), report({ hook: "dugout_other" }, false));
    const bad = await consolidate(randomUUID(), report({ hook: "dugout_third" }, false));
    const live = await store.builds(tenant, { sections: [SECTION], agentId: AGENT });
    // newest first: the latest failure, then the good one; the earlier failure is no longer live
    expect(live.map((b) => [b.id, (b.value as BuildRecord).outcome.good])).toEqual([
      [bad.build?.id, false],
      [first.build?.id, true],
    ]);
    expect(await store.builds(tenant, { sections: ["sig-other"] })).toEqual([]);
    expect(await store.builds(tenant, { agentId: "hook-maker" })).toEqual([]);
  });

  it("is not found by a search that did not ask for builds, and can be forgotten", async () => {
    const out = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    const found = await store.search({
      tenantId: tenant,
      query: "fixtures strip",
      kinds: ["episodic"],
    });
    expect(found).toEqual([]);
    expect(await store.forgetEpisode(tenant, out.build?.id ?? "")).toBe(true);
    expect(await store.builds(tenant)).toEqual([]);
  });

  it("keeps a reviewer's change request on the record", async () => {
    const runId = randomUUID();
    const events = runEvents(runId);
    const answered = events.find((e) => e.type === "question.answered");
    if (answered?.type === "question.answered")
      answered.data.answers = { review: { decision: "change", comment: "the date is wrong" } };
    const out = await consolidate(runId, report({ hook: "dugout_fixtures" }), events);
    expect(recordOf(out.build).corrected).toEqual([
      { at: "2026-11-10T09:00:00Z", by: "sam", what: "the date is wrong", runId },
    ]);
  });
});

describe("reading builds (ADR 0034)", () => {
  it("lists the latest good records of the section and what failed, as an index", async () => {
    const good = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    const bad = await consolidate(randomUUID(), report({ hook: "dugout_other" }, false));
    await consolidate(randomUUID(), report({ hook: "x" }), runEvents(randomUUID(), {}));
    const built = await builtFor(store, tenant, SECTION, AGENT);
    expect(built?.same.map((l) => l.id)).toContain(good.build?.id);
    expect(built?.failed.map((l) => l.id)).toEqual([bad.build?.id]);
    expect(built?.failed[0]?.line).toContain("not good: the date is not in the design's form");
    expect(built?.rule).toMatch(/never copy a value/);
    // not another agent's, not another section's, and no reader or section is nothing
    expect(await builtFor(store, tenant, SECTION, "frame-match")).toBeUndefined();
    expect(await builtFor(store, tenant, "sig-other", AGENT)).toBeUndefined();
    expect(await builtFor(undefined, tenant, SECTION, AGENT)).toBeUndefined();
    expect(await builtFor(store, tenant, undefined, AGENT)).toBeUndefined();
  });

  it("puts a record a person corrected after a clean one, and names the correction", async () => {
    const runId = randomUUID();
    const events = runEvents(runId);
    const answered = events.find((e) => e.type === "question.answered");
    if (answered?.type === "question.answered")
      answered.data.answers = { review: { decision: "change", comment: "the date is wrong" } };
    const corrected = await consolidate(runId, report({ hook: "dugout_a" }), events);
    const clean = await consolidate(randomUUID(), report({ hook: "dugout_b" }));
    const built = await builtFor(store, tenant, SECTION, AGENT);
    expect(built?.same.map((l) => l.id)).toEqual([clean.build?.id, corrected.build?.id]);
    expect(built?.same[1]?.corrected).toBe("the date is wrong");
  });

  it("keeps the index inside its budget by dropping lines whole", async () => {
    const long = "x".repeat(900);
    await consolidate(randomUUID(), report({ hook: "a" }));
    await consolidate(randomUUID(), report({ hook: "b", note: long }));
    await consolidate(randomUUID(), report({ hook: "c" }, false));
    const built = await builtFor(store, tenant, SECTION, AGENT);
    expect(built).toBeDefined();
    expect(JSON.stringify(built).length / 4).toBeLessThanOrEqual(1_500);
    for (const l of [...(built?.same ?? []), ...(built?.failed ?? [])])
      expect(l.line.length).toBeLessThanOrEqual(200);
  });

  it("reads one record in full by id, for this tenant only", async () => {
    const out = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    const read = memoryTool("memory.read");
    const ctx = (tenantId: string) => ({ tenantId }) as never;
    const full = await read.run({ id: out.build?.id ?? "" }, ctx(tenant));
    expect(full).toMatchObject({
      agent: AGENT,
      good: true,
      did: { hook: "dugout_fixtures" },
      section: { signature: SECTION },
    });
    await expect(read.run({ id: out.build?.id ?? "" }, ctx("someone-else"))).rejects.toThrow(
      /no build record/,
    );
    await expect(read.run({ id: "not-an-id-at-all" }, ctx(tenant))).rejects.toThrow(
      /no build record/,
    );
  });
});

describe("like sections in built (ADR 0034)", () => {
  const record = (signature: string, did: unknown, good = true): Promise<unknown> => {
    const events = runEvents(randomUUID()).map((e) =>
      e.type === "tool.completed"
        ? { ...e, data: { ...e.data, situation: { section: signature } } }
        : e,
    ) as RunEvent[];
    return consolidate(randomUUID(), report(did, good), events);
  };

  it("lists the good record of a like section, with why, and nothing of an unlike one", async () => {
    await record("sig-like", { hook: "dugout_fixtures" });
    await record("sig-unlike", { hook: "dugout_news" });
    await record("sig-like-bad", { hook: "dugout_bad" }, false);
    const like = async () => [
      { signature: "sig-like", why: "same kind and layout, 5 of 6 fields alike" },
      { signature: "sig-like-bad", why: "same kind and layout, 4 of 5 fields alike" },
    ];
    const built = await builtFor(store, tenant, SECTION, AGENT, like);
    expect(built?.same).toEqual([]);
    expect(built?.like).toHaveLength(1);
    expect(built?.like?.[0]).toMatchObject({
      why: "same kind and layout, 5 of 6 fields alike",
      good: true,
    });
    // abstains: a finder that finds nothing leaves nothing, and so does a failing one
    expect(await builtFor(store, tenant, SECTION, AGENT, async () => [])).toBeUndefined();
    expect(
      await builtFor(store, tenant, SECTION, AGENT, async () => {
        throw new Error("library down");
      }),
    ).toBeUndefined();
  });

  it("keeps the same section's records and the like ones side by side, like first to go", async () => {
    await record(SECTION, { hook: "dugout_same" });
    await record("sig-like", { hook: "dugout_fixtures" });
    const built = await builtFor(store, tenant, SECTION, AGENT, async () => [
      { signature: "sig-like", why: "alike" },
    ]);
    expect(built?.same).toHaveLength(1);
    expect(built?.like).toHaveLength(1);
  });
});

describe("pinned facts (ADR 0034)", () => {
  const seed = async (key: string, content: string) => {
    const p = await store.proposeFact({
      tenantId: tenant,
      agentId: null,
      key,
      content,
      confidence: 1,
      sourceRunId: "seed",
    });
    await store.activateFact(tenant, p.id, "test");
  };
  const context = (pin?: string[], factsBudgetTokens?: number) =>
    buildContext({
      reader: store,
      skillsDir: "/nonexistent",
      skills: [],
      onDemandSkills: [],
      tenantId: tenant,
      agentId: AGENT,
      query: "x",
      budgetTokens: 50_000,
      readSemantic: true,
      readEpisodic: false,
      ...(pin ? { pin } : {}),
      ...(factsBudgetTokens ? { factsBudgetTokens } : {}),
    });

  it("puts only the pinned facts in the prompt, and says what it left out", async () => {
    await seed("club.team", "The club is Southern Brave.");
    await seed("style.spelling", "Use British spelling.");
    await seed("style.length", "Keep previews short.");
    const all = await context();
    expect(all.text).toContain("Use British spelling.");
    expect(all.text).not.toContain("more fact");
    const pinned = await context(["club."]);
    expect(pinned.text).toContain("The club is Southern Brave.");
    expect(pinned.text).not.toContain("British");
    expect(pinned.text).toContain(
      "2 more facts are not shown, under style.. Find one with memory.search.",
    );
    expect(pinned.sources.map((x) => x.id)).toHaveLength(1);
  });

  it("says when facts did not fit, not nothing", async () => {
    for (const n of [1, 2, 3, 4])
      await seed(`club.fact${n}`, `A fact number ${n} ${"x".repeat(200)}`);
    const tight = await context(["club."], 120);
    expect(tight.text).toMatch(/\d+ did not fit here\. Find one with memory\.search\./);
  });

  it("is silent when every fact is there", () => {
    expect(factsNote([], 0)).toBe("");
  });

  it("searches build records by their words and gives their ids", async () => {
    const out = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    const search = memoryTool("memory.search");
    const ctx = { tenantId: tenant } as never;
    const found = (await search.run(
      { query: "Fixtures strip", kinds: ["build"], limit: 5 },
      ctx,
    )) as Array<{
      id: string;
      kind: string;
    }>;
    expect(found.map((f) => [f.kind, f.id])).toEqual([["build", out.build?.id]]);
    // a search that did not ask for builds does not return them
    expect(
      await search.run({ query: "Fixtures strip", kinds: ["episodic"], limit: 5 }, ctx),
    ).toEqual([]);
  });
});

describe("what happened next (ADR 0034)", () => {
  const PREVIEW = "http://localhost:3000/preview/default/tree-1";

  it("adds a person's comments to the record of the preview and keeps them as lessons", async () => {
    const out = await consolidate(randomUUID(), report({ hook: "dugout_fixtures" }));
    expect(recordOf(out.build).run.previewUrl).toBe("http://localhost:3000/preview/default/t");
    expect((await store.buildsNaming(tenant, "t")).map((i) => i.id)).toEqual([out.build?.id]);
    expect(await store.buildsNaming(tenant, "other")).toEqual([]);
    expect(await store.buildsNaming(tenant, "t/../x")).toEqual([]);
    // a segment of the link, not a part of one
    expect(await store.buildsNaming(tenant, "defaul")).toEqual([]);

    const done = await recordCorrections({
      writer: store,
      tenantId: tenant,
      agentId: "ui-editor",
      runId: "edit-1",
      at: "2026-11-11T08:00:00Z",
      report: {
        of: "t",
        edited: PREVIEW,
        comments: ["make the score bigger, mail sam@example.com"],
      },
    });
    expect(done.corrected).toBe(1);
    const after = recordOf((await store.builds(tenant))[0]);
    expect(after.corrected).toEqual([
      {
        at: "2026-11-11T08:00:00Z",
        by: "comment",
        what: "make the score bigger, mail [REDACTED:email]",
        runId: "edit-1",
      },
    ]);
    // the next comment, on the edited preview, finds the record again
    expect((await store.buildsNaming(tenant, "tree-1")).length).toBe(1);
    const lessons = await store.lessonsOn(tenant, [SECTION]);
    expect(lessons.map((l) => l.content)).toEqual([
      'After this section was built, a person asked: "make the score bigger, mail [REDACTED:email]"',
    ]);
    expect(await store.lessonsOn(tenant, ["sig-other"])).toEqual([]);
    const built = await builtFor(store, tenant, SECTION, AGENT);
    expect(built?.same[0]?.corrected).toContain("make the score bigger");
  });

  it("leaves a preview no record knows alone", async () => {
    const done = await recordCorrections({
      writer: store,
      tenantId: tenant,
      agentId: "ui-editor",
      runId: "edit-2",
      at: "2026-11-11T08:00:00Z",
      report: { of: "nobody", comments: ["bigger"] },
    });
    expect(done).toEqual({ corrected: 0, lessons: [] });
    expect(await store.lessonsOn(tenant, [SECTION])).toEqual([]);
  });

  it("learns a reviewer's words as a lesson about the section; the writer is told the section", async () => {
    const runId = randomUUID();
    const events = runEvents(runId);
    const answered = events.find((e) => e.type === "question.answered");
    if (answered?.type === "question.answered")
      answered.data.answers = {
        review: { decision: "reject", comment: "this is a static section" },
      };
    let seen: unknown;
    await consolidateRun({
      writer: store,
      tenantId: tenant,
      agentId: AGENT,
      runId,
      events,
      record: report({ hook: "a" }),
      model: "sonnet",
      lessons: async (r) => {
        seen = r;
        return "Leave a static section static.";
      },
    });
    expect(seen).toMatchObject({
      section: { name: "Fixtures strip" },
      model: "sonnet",
      reason: "this is a static section",
    });
    const lessons = await store.lessonsOn(tenant, [SECTION]);
    expect(lessons[0]?.content).toBe(
      'Leave a static section static. (Reviewer: "this is a static section")',
    );
  });
});

describe("patterns to facts (ADR 0034)", () => {
  /** A record of a run of one agent on one section, written as consolidation does. */
  const built = async (
    agent: string,
    signature: string,
    over: {
      good?: boolean;
      patterns?: BuildPattern[];
      labels?: Record<string, string>;
    } = {},
  ) => {
    const runId = randomUUID();
    const events = runEvents(runId).map((e) =>
      e.type === "tool.completed"
        ? { ...e, data: { ...e.data, situation: { section: signature } } }
        : e,
    ) as RunEvent[];
    return consolidateRun({
      writer: store,
      tenantId: tenant,
      agentId: agent,
      runId,
      events,
      record: () => ({
        did: {},
        good: over.good ?? true,
        line: "did it",
        ...(over.patterns ? { patterns: over.patterns } : {}),
        ...(over.labels ? { section: { labels: over.labels } } : {}),
      }),
    });
  };
  /** What a finder of data says: the list it fed, and the hook that fed it. */
  const hook = (hookId: string) => ({
    labels: { list: "Fixtures" },
    patterns: [
      {
        key: "data.hook.{list}",
        value: { hook: hookId, list: "{list}" },
        sentence: `The hook ${hookId} feeds the list "{list}"`,
      },
    ],
  });

  it("proposes what three sections' records agree on, once, with the labels filled in", async () => {
    await built("finder", "s1", hook("dugout_fixtures"));
    await built("finder", "s2", hook("dugout_fixtures"));
    expect(
      (await store.listProposals(tenant)).filter((p) => p.key?.startsWith("data.hook.")),
    ).toEqual([]);
    const third = await built("finder", "s3", hook("dugout_fixtures"));
    expect(third.proposals.map((p) => [p.key, p.value])).toEqual([
      ["data.hook.fixtures", { hook: "dugout_fixtures", list: "Fixtures" }],
    ]);
    expect(third.proposals[0]?.content).toBe(
      'The hook dugout_fixtures feeds the list "Fixtures" (on 3 sections).',
    );
    expect(third.proposals[0]?.sources).toHaveLength(3);
    // the same pattern is not proposed again
    const fourth = await built("finder", "s4", hook("dugout_fixtures"));
    expect(fourth.proposals).toEqual([]);
  });

  it("proposes nothing when sections disagree, or when the records were not good", async () => {
    const records = async () => store.builds(tenant, { limit: 500 });
    await built("finder", "s1", hook("dugout_a"));
    await built("finder", "s2", hook("dugout_a"));
    await built("finder", "s3", hook("dugout_b"));
    await built("finder", "s4", hook("dugout_b"));
    expect(patternsOf(await records())).toEqual([]);
    await built("finder", "s5", { ...hook("dugout_c"), good: false });
    await built("finder", "s6", { ...hook("dugout_c"), good: false });
    await built("finder", "s7", { ...hook("dugout_c"), good: false });
    expect(patternsOf(await records())).toEqual([]);
  });

  it("names a pattern by another agent's label on the same section, and skips a section with none", async () => {
    const layout: BuildPattern = {
      key: "layout.{list}",
      value: { layout: "carousel", list: "{list}" },
      sentence: 'A section that shows the list "{list}" is a carousel',
    };
    for (const s of ["l1", "l2", "l3"]) {
      // the label is given by any agent's latest record on the section, good or not
      await built("finder", s, { labels: { list: "Fixtures" }, good: false });
      await built("matcher", s, { patterns: [layout] });
    }
    // a section no record labels votes for nothing
    await built("matcher", "l4", { patterns: [layout] });
    const date: BuildPattern = {
      key: "form.date.published-date",
      value: { pipe: 'date:"DD MMM"', field: "published-date" },
      sentence: 'A published date is written with the pipe date:"DD MMM"',
    };
    for (const s of ["d1", "d2", "d3"]) await built("binder", s, { patterns: [date] });
    const patterns = patternsOf(await store.builds(tenant, { limit: 500 }));
    expect(patterns.map((p) => [p.key, p.value, p.content, p.sources.length])).toEqual([
      [
        "form.date.published-date",
        { pipe: 'date:"DD MMM"', field: "published-date" },
        'A published date is written with the pipe date:"DD MMM" (on 3 sections).',
        3,
      ],
      [
        "layout.fixtures",
        { layout: "carousel", list: "Fixtures" },
        'A section that shows the list "Fixtures" is a carousel (on 3 sections).',
        3,
      ],
    ]);
  });

  it("reads nothing from a record written before agents gave patterns", async () => {
    // a v1 record: the agent's payload, no patterns or labels
    for (const s of ["o1", "o2", "o3"]) await built("finder", s);
    expect(patternsOf(await store.builds(tenant, { limit: 500 }))).toEqual([]);
  });

  it("fills a pattern's labels in only where its key names them", () => {
    const p: BuildPattern = {
      key: "a.{x}",
      value: { v: "{x} and {y}" },
      sentence: "{x} uses {y}",
    };
    expect(resolvePattern(p, { x: "Big List" })).toEqual({
      key: "a.big-list",
      value: { v: "Big List and {y}" },
      sentence: "Big List uses {y}",
    });
    expect(resolvePattern(p, {})).toBeUndefined();
  });

  it("is read by the load tools once a person approved it, and not before", async () => {
    for (const s of ["s1", "s2", "s3"]) await built("finder", s, hook("dugout_fixtures"));
    expect(await patternsFor(store, tenant, ["data.hook."])).toEqual([]);
    const [proposal] = await store.listProposals(tenant);
    await store.activateFact(tenant, proposal?.id ?? "", "sam");
    expect(await patternsFor(store, tenant, ["data.hook."])).toEqual([
      'data.hook.fixtures: The hook dugout_fixtures feeds the list "Fixtures" (on 3 sections).',
    ]);
    expect(await patternsFor(store, tenant, ["layout."])).toEqual([]);
    expect(
      await proposePatterns({ writer: store, tenantId: tenant, agentId: "x", runId: "r" }),
    ).toEqual([]);
  });
});
