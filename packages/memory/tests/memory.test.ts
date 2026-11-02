import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_APPROVED, type RunEvent } from "@dugout/contracts";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  type BuildContextOptions,
  buildContext,
  consolidateRun,
  createHashEmbeddings,
  createMemoryStore,
  createMemoryTools,
  createSkillTool,
  type EpisodeType,
  estimateTokens,
  lessonScore,
  type MemoryStore,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store: MemoryStore = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const AGENT = "drafter";
const NOW = Date.parse("2026-11-01T00:00:00Z");

let a: string;
let b: string;
beforeEach(() => {
  const suffix = randomUUID().slice(0, 8);
  a = `t-a-${suffix}`;
  b = `t-b-${suffix}`;
});

const fact = async (
  tenantId: string,
  key: string,
  content: string,
  proposedBy: string | null = null,
) => {
  const p = await store.proposeFact({
    tenantId,
    agentId: proposedBy,
    key,
    content,
    confidence: 1,
    sourceRunId: null,
  });
  return store.activateFact(tenantId, p.id, "seed");
};
const episode = (
  tenantId: string,
  content: string,
  ttlDays = 30,
  sourceRunId = randomUUID(),
  episodeType: EpisodeType = "lesson",
  agentId = AGENT,
) =>
  store.addEpisode({
    tenantId,
    agentId,
    episodeType,
    content,
    confidence: 0.9,
    sourceRunId,
    ttlDays,
  });

describe("tenant isolation", () => {
  it("never returns another tenant's items from search, facts or lookups by id", async () => {
    const own = await fact(a, "style.spelling", "Use British English spelling");
    await episode(a, "Reviewer rejected a draft that mentioned betting odds");

    const searchB = await store.search({ tenantId: b, query: "betting odds British spelling" });
    expect(searchB).toEqual([]);
    expect(await store.activeFacts(b)).toEqual([]);
    expect(await store.history(b, "style.spelling")).toEqual([]);
    await expect(store.activateFact(b, own.id, "intruder")).rejects.toThrow("not found");
    await expect(store.rejectProposal(b, own.id, "intruder")).rejects.toThrow("not found");
    expect(await store.deleteBySourceRun(b, own.sourceRunId ?? "none")).toBe(0);
  });

  it("scopes the memory.search tool by the run's tenant, not by its input", async () => {
    await episode(a, "Never mention the toss result");
    const [search] = createMemoryTools({ reader: store });
    const run = (tenantId: string) =>
      search?.run({ query: "toss result", kinds: ["episodic"], limit: 5 } as never, {
        tenantId,
        runId: "r",
        signal: new AbortController().signal,
      });
    expect(await run(a)).toHaveLength(1);
    expect(await run(b)).toEqual([]);
  });
});

describe("facts belong to the tenant", () => {
  const contents = (items: Array<{ key: string | null; content: string }>) =>
    items.map((f) => `${f.key}: ${f.content}`);

  it("are read the same way whichever agent proposed them", async () => {
    await fact(a, "style.spelling", "Use British English");
    await fact(a, "audience", "Cricket fans", "sitemap");

    expect(contents(await store.activeFacts(a))).toEqual([
      "audience: Cricket fans",
      "style.spelling: Use British English",
    ]);
    expect(await store.activeFacts(b)).toEqual([]);
  });

  it("keep one active version per key, whoever proposed each version", async () => {
    await fact(a, "style.length", "At most 120 words");
    await fact(a, "style.length", "At most 100 words", AGENT);
    await fact(a, "style.length", "At most 80 words", "sitemap");

    expect(
      (await store.history(a, "style.length")).map((h) => [h.version, h.status, h.agentId]),
    ).toEqual([
      [1, "retired", null],
      [2, "retired", AGENT],
      [3, "active", "sitemap"],
    ]);
    expect(contents(await store.activeFacts(a))).toEqual(["style.length: At most 80 words"]);
  });

  it("take turns when two versions of one key are activated at once", async () => {
    const propose = (content: string) =>
      store.proposeFact({
        tenantId: a,
        agentId: null,
        key: "style.tone",
        content,
        confidence: 1,
        sourceRunId: null,
      });
    const [one, two] = await Promise.all([propose("Measured"), propose("Energetic")]);
    await Promise.all([
      store.activateFact(a, one.id, "reviewer-1"),
      store.activateFact(a, two.id, "reviewer-2"),
    ]);
    expect(await store.activeFacts(a)).toHaveLength(1);
  });

  it("are found by search together with every agent's episodes", async () => {
    await fact(a, "style.spelling", "Use British English spelling");
    await episode(
      a,
      "A reviewer asked for British spelling",
      30,
      randomUUID(),
      "lesson",
      "sitemap",
    );

    const found = await store.search({ tenantId: a, query: "British spelling" });
    expect(found.map((f) => f.content).sort()).toEqual([
      "A reviewer asked for British spelling",
      "Use British English spelling",
    ]);
  });
});

describe("episodes", () => {
  it("strengthen a lesson seen again instead of adding a copy", async () => {
    const first = await episode(a, "Never use betting language in previews");
    const again = await episode(a, "Never use betting language in previews");
    expect(again).toMatchObject({ id: first.id, strength: 2, reinforced: true });
    // a repeat with a shorter life never shortens the lesson's
    const third = await episode(a, "Never use betting language in previews", -1);
    expect(third.strength).toBe(3);
    expect(Date.parse(third.expiresAt ?? "")).toBeGreaterThan(Date.now());
    // run records are always their own episode
    await episode(a, "Input {}: completed.", 30, randomUUID(), "run");
    const run = await episode(a, "Input {}: completed.", 30, randomUUID(), "run");
    expect(run.reinforced).toBe(false);

    const lessons = await store.recallEpisodes({
      tenantId: a,
      agentId: AGENT,
      query: "betting language",
      episodeType: "lesson",
    });
    expect(lessons.map((l) => [l.content, l.strength])).toEqual([
      ["Never use betting language in previews", 3],
    ]);
  });

  it("returns the same lessons to every agent, ordered by similarity", async () => {
    await episode(a, "Keep headlines short", 30, randomUUID(), "lesson", "sitemap");
    await episode(a, "Keep headlines tight", 30, randomUUID(), "lesson", AGENT);
    // the same lesson from another agent strengthens the one already there
    const repeat = await episode(a, "Keep headlines tight", 30, randomUUID(), "lesson", "sitemap");
    expect(repeat).toMatchObject({ reinforced: true, strength: 2, agentId: AGENT });

    const recall = (agentId: string) =>
      store.recallEpisodes({ tenantId: a, agentId, query: "headlines", episodeType: "lesson" });
    const forAgent = (await recall(AGENT)).map((l) => l.content);
    const forSitemap = (await recall("sitemap")).map((l) => l.content);
    expect(forSitemap).toEqual(forAgent);
    expect(forAgent).toEqual(["Keep headlines tight", "Keep headlines short"]);
  });

  it("finds a lesson by the input of the run it was learned on", async () => {
    const situation = JSON.stringify({ fixtureId: "c-103" });
    await store.addEpisode({
      tenantId: a,
      agentId: AGENT,
      episodeType: "lesson",
      content: "Never call a match a clash",
      situation,
      confidence: 0.9,
      sourceRunId: randomUUID(),
      ttlDays: 30,
    });
    await store.addEpisode({
      tenantId: a,
      agentId: AGENT,
      episodeType: "lesson",
      content: "Include only static pages in the sitemap",
      situation: JSON.stringify({ brief: "only static pages" }),
      confidence: 0.9,
      sourceRunId: randomUUID(),
      ttlDays: 30,
    });
    const found = await store.recallEpisodes({
      tenantId: a,
      agentId: AGENT,
      query: situation,
      episodeType: "lesson",
    });
    expect(found.map((l) => l.content)).toEqual(["Never call a match a clash"]);
  });

  it("leaves out a lesson whose embedding is not about the query", async () => {
    await episode(a, "Never use betting language in previews");
    await episode(a, "Include only static pages in the draft next time.");
    const found = await store.recallEpisodes({
      tenantId: a,
      agentId: AGENT,
      query: "betting language",
      episodeType: "lesson",
    });
    expect(found.map((l) => l.content)).toEqual(["Never use betting language in previews"]);
  });

  it("leave a run record of how each run ended, alongside its lessons", async () => {
    const runId = randomUUID();
    const ev = (seq: number, type: string, data: unknown) =>
      ({ runId, seq, at: "2026-10-30T00:00:00Z", type, data }) as RunEvent;
    const out = await consolidateRun({
      writer: store,
      tenantId: a,
      agentId: AGENT,
      runId,
      events: [
        ev(1, "run.started", {
          agentId: AGENT,
          agentVersion: 1,
          tenantId: a,
          input: { id: "c-1" },
        }),
        ev(2, "approval.requested", { step: 1, callId: "c1", tool: "draft.save", input: {} }),
        ev(3, "approval.changes_requested", {
          step: 1,
          callId: "c1",
          tool: "draft.save",
          by: "editor",
          changes: "Shorter title",
        }),
        ev(4, "run.completed", { status: "completed", output: null, usage: {} }),
      ],
    });
    expect(out.episodes.map((e) => e.episodeType)).toEqual(["lesson"]);
    expect(out.run).toMatchObject({
      episodeType: "run",
      content: 'Input {"id":"c-1"}: completed. Reviewer asked for a change: "Shorter title".',
    });
  });
});

describe("lesson ranking", () => {
  const recall = (query: string, limit?: number, agentId = AGENT) =>
    store.recallEpisodes({
      tenantId: a,
      agentId,
      query,
      episodeType: "lesson",
      ...(limit ? { limit } : {}),
    });

  it("puts the stronger of two equally similar lessons first", async () => {
    // the stronger one is the older one, so creation order can't explain the result
    await episode(a, "headline alpha");
    await episode(a, "headline alpha");
    await episode(a, "headline beta");
    const found = await recall("headline");
    expect(found.map((l) => [l.content, l.strength])).toEqual([
      ["headline alpha", 2],
      ["headline beta", 1],
    ]);
  });

  it("recalls a lesson seen three times however little it resembles the input", async () => {
    for (let i = 0; i < 3; i++) await episode(a, "zebra quokka wombat");
    await episode(a, "ostrich emu cassowary");
    const found = await recall("match preview headline");
    expect(found.map((l) => l.content)).toEqual(["zebra quokka wombat"]);
  });

  it("scores by similarity, strength, recency and the reading agent", () => {
    const base = { strength: 1, lastSeenAt: new Date(NOW).toISOString(), agentId: "other" };
    const score = (over: Partial<typeof base>) =>
      lessonScore({ ...base, ...over }, 0.5, AGENT, NOW);
    expect(score({})).toBeCloseTo(0.5 + 0.05, 5); // seen just now
    expect(score({ strength: 3 })).toBeCloseTo(0.5 + 0.1 + 0.05, 5);
    expect(score({ strength: 99 })).toBeCloseTo(0.5 + 0.2 + 0.05, 5); // capped at 4 repeats
    expect(score({ agentId: AGENT })).toBeCloseTo(0.5 + 0.05 + 0.05, 5);
    const old = new Date(NOW - 60 * 86_400_000).toISOString();
    expect(score({ lastSeenAt: old })).toBeCloseTo(0.5 + 0.05 * Math.exp(-1), 5);
  });
});

describe("hybrid search", () => {
  it("ranks items matching on both text and vector first, and skips expired episodes", async () => {
    await episode(a, "Spell kickoff times in 24-hour format");
    await episode(a, "Avoid the word clash in headlines");
    await episode(a, "Old rule: no clash in a headline", -1);
    const results = await store.search({
      tenantId: a,
      query: "headline word clash",
    });
    expect(results[0]?.content).toBe("Avoid the word clash in headlines");
    expect(results.map((r) => r.content)).not.toContain("Old rule: no clash in a headline");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("returns nothing for a query unrelated to everything stored", async () => {
    await episode(a, "Spell kickoff times in 24-hour format");
    await fact(a, "style.max-words", "At most 120 words");
    expect(await store.search({ tenantId: a, query: "quokka zebra wombat" })).toEqual([]);
  });

  it("survives queries with tsquery syntax in them", async () => {
    await episode(a, "Mention the venue");
    const results = await store.search({ tenantId: a, query: "venue' & ! (:*" });
    expect(results[0]?.content).toBe("Mention the venue");
  });
});

describe("semantic facts", () => {
  it("keeps proposals out of reads until reviewed, and versions every change", async () => {
    await fact(a, "style.max-words", "At most 120 words");
    const proposal = await store.proposeFact({
      tenantId: a,
      agentId: AGENT,
      key: "style.max-words",
      content: "At most 100 words",
      confidence: 0.8,
      sourceRunId: "run-1",
    });
    expect((await store.activeFacts(a)).map((f) => f.content)).toEqual(["At most 120 words"]);
    const search = await store.search({ tenantId: a, query: "100 words" });
    expect(search.map((s) => s.content)).not.toContain("At most 100 words");

    await store.activateFact(a, proposal.id, "editor");
    expect((await store.activeFacts(a)).map((f) => f.content)).toEqual(["At most 100 words"]);
    const history = await store.history(a, "style.max-words");
    expect(history.map((h) => [h.version, h.status, h.reviewedBy])).toEqual([
      [1, "retired", "seed"],
      [2, "active", "editor"],
    ]);
  });

  it("retires a rejected proposal", async () => {
    const p = await store.proposeFact({
      tenantId: a,
      agentId: AGENT,
      key: "k",
      content: "maybe",
      confidence: 0.2,
      sourceRunId: null,
    });
    await store.rejectProposal(a, p.id, "editor");
    expect(await store.listProposals(a)).toEqual([]);
    expect((await store.history(a, "k"))[0]?.status).toBe("retired");
  });
});

describe("consolidation", () => {
  const ev = (seq: number, type: string, data: unknown) =>
    ({ runId: "r", seq, at: "2026-10-29T00:00:00Z", type, data }) as RunEvent;

  const events = [
    ev(1, "approval.requested", {
      step: 1,
      callId: "c1",
      tool: "draft.save",
      input: { body: "Bet now on the Lions!" },
    }),
    ev(2, "approval.rejected", {
      step: 1,
      callId: "c1",
      tool: "draft.save",
      by: "editor",
      reason: "no betting language",
    }),
    ev(3, "tool.started", {
      step: 1,
      callId: "c2",
      tool: "memory.propose",
      input: { key: "style.tone", content: "Keep it upbeat", confidence: 0.6 },
    }),
    ev(4, "tool.completed", {
      step: 1,
      callId: "c2",
      tool: "memory.propose",
      ok: true,
      content: "{}",
      durationMs: 1,
    }),
  ];

  it("turns rejections into episodes and proposals into reviewable facts, with provenance", async () => {
    const runId = randomUUID();
    const seen: unknown[] = [];
    const out = await consolidateRun({
      writer: store,
      tenantId: a,
      agentId: AGENT,
      runId,
      events,
      lessons: async (r) => {
        seen.push(r);
        return "Never use betting language.";
      },
    });
    expect(seen).toEqual([
      {
        tool: "draft.save",
        input: { body: "Bet now on the Lions!" },
        reason: "no betting language",
      },
    ]);
    expect(out.episodes[0]).toMatchObject({
      kind: "episodic",
      status: "active",
      sourceRunId: runId,
      content: 'Never use betting language. (Reviewer: "no betting language")',
    });
    expect(out.episodes[0]?.expiresAt).not.toBeNull();
    expect(out.proposals[0]).toMatchObject({
      kind: "semantic",
      status: "proposed",
      key: "style.tone",
      agentId: AGENT,
      sourceRunId: runId,
    });
    expect(await store.deleteBySourceRun(a, runId)).toBe(2);
  });

  it("records which agent proposed a fact, for a reviewer to see", async () => {
    const out = await consolidateRun({
      writer: store,
      tenantId: a,
      agentId: AGENT,
      runId: randomUUID(),
      events: [
        ev(1, "tool.started", {
          step: 1,
          callId: "c9",
          tool: "memory.propose",
          input: { key: "audience", content: "Readers are T20 fans", confidence: 0.8 },
        }),
        ev(2, "tool.completed", {
          step: 1,
          callId: "c9",
          tool: "memory.propose",
          ok: true,
          content: "{}",
          durationMs: 1,
        }),
      ],
    });
    expect(out.proposals[0]).toMatchObject({ key: "audience", agentId: AGENT, status: "proposed" });
  });

  it("falls back to the raw reason when the lesson writer fails", async () => {
    const out = await consolidateRun({
      writer: store,
      tenantId: a,
      agentId: AGENT,
      runId: randomUUID(),
      events: events.slice(0, 2),
      lessons: async () => {
        throw new Error("model down");
      },
    });
    expect(out.episodes[0]?.content).toBe(
      'A reviewer rejected a draft.save draft: "no betting language"',
    );
  });

  it("remembers a change request like a rejection, with the draft it was about", async () => {
    const runId = randomUUID();
    const seen: unknown[] = [];
    const out = await consolidateRun({
      writer: store,
      tenantId: a,
      agentId: AGENT,
      runId,
      events: [
        events[0] as RunEvent,
        ev(2, "approval.changes_requested", {
          step: 1,
          callId: "c1",
          tool: "draft.save",
          by: "editor",
          changes: "Put Fixtures before News",
        }),
      ],
      lessons: async (r) => {
        seen.push(r);
        throw new Error("model down");
      },
    });
    expect(seen).toEqual([
      {
        tool: "draft.save",
        input: { body: "Bet now on the Lions!" },
        reason: "Put Fixtures before News",
      },
    ]);
    expect(out.episodes[0]?.content).toBe(
      'A reviewer asked for a change to a draft.save draft: "Put Fixtures before News"',
    );
    expect(await store.deleteBySourceRun(a, runId)).toBe(1);
  });

  it("proposes a lesson as a fact the third time it is repeated, and only once", async () => {
    const rejection = events.slice(0, 2);
    const repeat = () =>
      consolidateRun({
        writer: store,
        tenantId: a,
        agentId: AGENT,
        runId: randomUUID(),
        events: rejection,
        lessons: async () => "Never use betting language.",
      });
    await repeat();
    await repeat();
    expect(await store.listProposals(a)).toEqual([]);
    const third = await repeat();
    expect(third.episodes[0]?.strength).toBe(3);
    const proposals = await store.listProposals(a);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "proposed",
      agentId: AGENT,
      content: 'Never use betting language. (Reviewer: "no betting language")',
    });
    expect(proposals[0]?.key).toMatch(/^lesson\.[0-9a-f]{8}$/);
    await repeat();
    expect(await store.listProposals(a)).toHaveLength(1);
  });

  it("redacts what it stores from a run's input and a reviewer's words", async () => {
    const out = await consolidateRun({
      writer: store,
      tenantId: a,
      agentId: AGENT,
      runId: randomUUID(),
      events: [
        ev(1, "run.started", {
          agentId: AGENT,
          agentVersion: 1,
          tenantId: a,
          input: { contact: "fan@example.com" },
        }),
        ...events.slice(0, 1),
        ev(3, "approval.rejected", {
          step: 1,
          callId: "c1",
          tool: "draft.save",
          by: "editor",
          reason: "mail jo@example.org first",
        }),
        ev(4, "run.completed", { status: "rejected", output: null, usage: {} }),
      ],
    });
    const text = JSON.stringify([out.episodes, out.run]);
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("example.org");
    expect(text).toContain("[REDACTED:email]");
  });
});

describe("approved examples", () => {
  const ev = (seq: number, type: string, data: unknown) =>
    ({ runId: "r", seq, at: "2026-11-01T00:00:00Z", type, data }) as RunEvent;
  const input = { fixtureId: "c-101", note: "mail fan@example.com" };
  const call = (callId: string, body: string) =>
    ev(2, "approval.requested", { step: 1, callId, tool: "draft.save", input: { body } });
  const granted = (callId: string) =>
    ev(3, "approval.granted", { step: 1, callId, tool: "draft.save", by: "editor" });
  const started = () =>
    ev(1, "run.started", { agentId: AGENT, agentVersion: 1, tenantId: a, input });
  const completed = ev(9, "run.completed", { status: "completed", output: null, usage: {} });
  const consolidate = (events: RunEvent[]) =>
    consolidateRun({ writer: store, tenantId: a, agentId: AGENT, runId: randomUUID(), events });

  // examples are recalled memory, so they are in `recalled`, not the instructions
  const text = async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-"));
    return (
      await buildContext({
        reader: store,
        skillsDir: dir,
        skills: [],
        onDemandSkills: [],
        tenantId: a,
        agentId: AGENT,
        query: JSON.stringify(input),
        budgetTokens: 10_000,
        readSemantic: true,
        readEpisodic: true,
      })
    ).recalled;
  };

  it("stores the last approved call and shows it in the context", async () => {
    await consolidate([
      started(),
      call("c1", "first draft"),
      granted("c1"),
      call("c2", "final draft"),
      granted("c2"),
      completed,
    ]);
    const stored = await store.recallEpisodes({
      tenantId: a,
      agentId: AGENT,
      query: JSON.stringify(input),
      episodeType: "example",
    });
    expect(stored.map((e) => e.content)).toEqual(['draft.save: {"body":"final draft"}']);
    expect(stored[0]).toMatchObject({ confidence: 1, episodeType: "example" });

    const shown = await text();
    expect(shown).toContain(
      "## Approved examples\n\nPast work an editor approved. Use it for style and structure only. Never copy its facts, names or numbers.",
    );
    expect(shown).toContain('draft.save: {"body":"final draft"}');
    expect(shown).not.toContain("first draft");
  });

  it("stores none for a run an approval nobody made let through", async () => {
    // `--yes` and the watcher record "<who> (auto)": output no editor looked at is not "past work
    // an editor approved", and would teach later runs to imitate whatever the model produced
    const auto = ev(3, "approval.granted", {
      step: 1,
      callId: "c1",
      tool: "draft.save",
      by: `sam${AUTO_APPROVED}`,
    });
    await consolidate([started(), call("c1", "unreviewed"), auto, completed]);
    expect(await text()).not.toContain("Approved examples");
    // an editor's later approval of another run still counts
    await consolidate([started(), call("c2", "reviewed"), granted("c2"), completed]);
    expect(await text()).toContain('draft.save: {"body":"reviewed"}');
    expect(await text()).not.toContain("unreviewed");
  });

  it("stores none for a run that was rejected or did not complete", async () => {
    const rejected = ev(4, "approval.rejected", {
      step: 1,
      callId: "c1",
      tool: "draft.save",
      by: "editor",
      reason: "no",
    });
    await consolidate([
      started(),
      call("c1", "x"),
      rejected,
      ev(9, "run.completed", { status: "rejected", output: null, usage: {} }),
    ]);
    // approved, but the run failed afterwards
    await consolidate([
      started(),
      call("c1", "x"),
      granted("c1"),
      ev(9, "run.failed", { reason: "error", message: "boom", usage: {} }),
    ]);
    expect(await text()).not.toContain("Approved examples");
  });

  it("keeps an email in the input out of stored text", async () => {
    await consolidate([
      started(),
      call("c1", "write to fan@example.com"),
      granted("c1"),
      completed,
    ]);
    const { rows } = await pool.query("select content from memory_items where tenant_id = $1", [a]);
    expect(JSON.stringify(rows)).not.toContain("example.com");
    expect(await text()).toContain("[REDACTED:email]");
  });

  it("skips an example over 4,000 characters", async () => {
    await consolidate([started(), call("c1", "x".repeat(4000)), granted("c1"), completed]);
    expect(await text()).not.toContain("Approved examples");
  });

  it("shows an agent only its own examples", async () => {
    await episode(a, "sitemap: pages for a club", 30, randomUUID(), "example", "sitemap");
    const recall = (agentId: string) =>
      store.recallEpisodes({
        tenantId: a,
        agentId,
        query: "sitemap: pages for a club",
        episodeType: "example",
      });
    expect(await recall("sitemap")).toHaveLength(1);
    expect(await recall(AGENT)).toEqual([]);
  });

  it("recalls at most two, and memory.search returns none", async () => {
    for (const body of ["one", "two", "three"]) {
      await consolidate([started(), call("c1", body), granted("c1"), completed]);
    }
    expect((await text()).match(/draft\.save: /g)).toHaveLength(2);
    const found = await store.search({ tenantId: a, query: "draft.save body fixtureId" });
    expect(found.filter((i) => i.episodeType === "example")).toEqual([]);
    expect(
      await store.search({ tenantId: a, query: "draft save", episodeType: "example" }),
    ).toEqual([]);
  });
});

describe("context builder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skills-"));
    await writeFile(join(dir, "preview.md"), "Write a preview.");
    await writeFile(
      join(dir, "derby.md"),
      "---\ndescription: How to preview a local derby\n---\nOpen with the rivalry.",
    );
    await writeFile(join(dir, "plain.md"), "No description here.");
  });

  const context = (overrides: Partial<BuildContextOptions> = {}) =>
    buildContext({
      reader: store,
      skillsDir: dir,
      skills: ["preview"],
      onDemandSkills: [],
      tenantId: a,
      agentId: AGENT,
      query: "preview headline",
      budgetTokens: 10_000,
      readSemantic: true,
      readEpisodic: true,
      ...overrides,
    });

  it("loads skills, then facts, then episodes, within the budget", async () => {
    await fact(a, "style.a", "Fact one about spelling");
    await fact(a, "style.b", "Fact two about word limits");
    for (let i = 0; i < 5; i++) await episode(a, `Lesson ${i} about the preview headline`);
    await episode(a, "Input preview headline: completed.", 30, randomUUID(), "run");

    const full = await context();
    expect(full.text).toContain("## Skill: preview\n\nWrite a preview.");
    // run records are still written but no longer shown
    expect(full.text).not.toContain("Similar past runs");
    expect(full.text).not.toContain("Input preview headline: completed.");
    // lessons are recalled memory: in `recalled`, with the date, not in the instructions
    expect(full.text).not.toContain("Lessons from past runs");
    expect(full.text).not.toContain("Lesson 0");
    expect(full.recalled).toMatch(
      /^<recalled_memory>\nToday is \d{4}-\d{2}-\d{2}\.\n\n## Lessons from past runs\n\n/,
    );
    expect(full.recalled).toContain("Lesson 0 about the preview headline");
    expect(full.recalled).toMatch(/<\/recalled_memory>$/);
    expect(full.sources[0]?.text).toBe("skill preview (loaded in full): Write a preview.");
    expect(full.sources.find((s) => s.kind === "semantic")?.text).toBe("Fact one about spelling");
    expect(full.sources.map((s) => s.kind)).toEqual([
      "procedural",
      "semantic",
      "semantic",
      "episodic",
      "episodic",
      "episodic",
      "episodic",
      "episodic",
    ]);

    const tight = await context({ budgetTokens: 60 });
    expect(tight.tokens).toBeLessThanOrEqual(60);
    expect(estimateTokens(tight.text)).toBeLessThanOrEqual(60);
    expect(tight.sources.length).toBeLessThan(full.sources.length);
    expect(tight.sources[0]?.kind).toBe("procedural");
  });

  it("builds the same instructions for any input, and dates the recalled memory from `now`", async () => {
    await fact(a, "style.a", "Fact one about spelling");
    await episode(a, "Lesson about the cup final preview");
    await episode(a, "Lesson about a derby headline");
    const first = await context({ query: "cup final", now: new Date("2026-03-04T23:30:00Z") });
    const second = await context({ query: "derby headline" });
    expect(second.text).toBe(first.text);
    expect(first.recalled).toContain("Today is 2026-03-04.");
    expect(first.recalled).not.toEqual(second.recalled);
  });

  it("stops adding lessons at the recalled cap, and facts at the facts cap, without counting skills", async () => {
    const long = (n: number) => `Lesson ${n} about the preview headline ${"x".repeat(100)}`;
    for (let i = 0; i < 5; i++) await episode(a, long(i));
    for (let i = 0; i < 5; i++) await fact(a, `style.${i}`, `Fact ${i} ${"y".repeat(100)}`);

    const all = await context();
    const lessons = (c: { sources: Array<{ kind: string }> }) =>
      c.sources.filter((s) => s.kind === "episodic").length;
    const facts = (c: { sources: Array<{ kind: string }> }) =>
      c.sources.filter((s) => s.kind === "semantic").length;
    expect(lessons(all)).toBe(5);
    expect(facts(all)).toBe(5);

    // a line is about 35 tokens, the title another 40: room for two lessons, then no more
    const capped = await context({ recalledBudgetTokens: 120, factsBudgetTokens: 120 });
    expect(lessons(capped)).toBeGreaterThan(0);
    expect(lessons(capped)).toBeLessThan(5);
    expect(facts(capped)).toBeGreaterThan(0);
    expect(facts(capped)).toBeLessThan(5);
    expect(capped.recalled.match(/- \(.*\) Lesson \d/g)).toHaveLength(lessons(capped));
    expect(capped.recalled).toContain("</recalled_memory>");
    // the skill is in both and costs neither cap
    expect(capped.sources[0]?.kind).toBe("procedural");
    const nothing = await context({ recalledBudgetTokens: 0, factsBudgetTokens: 0 });
    expect(lessons(nothing)).toBe(0);
    expect(facts(nothing)).toBe(0);
    expect(nothing.text).toContain("## Skill: preview");
  });

  it("lists skills to load by name and description, without their text", async () => {
    const { text, sources } = await context({ onDemandSkills: ["derby"] });
    expect(text).toContain(
      "## Skills you can load\n\nOnly their descriptions are here. When the task needs one, call skill.load with its name to get its instructions.\n\n- derby: How to preview a local derby",
    );
    expect(text).not.toContain("Open with the rivalry.");
    expect(sources.map((s) => s.id)).toContain("skill:derby");
    expect((await context()).text).not.toContain("Skills you can load");
  });

  it("refuses a skill to load that has no description to choose it by", async () => {
    await expect(context({ onDemandSkills: ["plain"] })).rejects.toThrow("add a description");
  });
});

describe("skill.load", () => {
  const ctx = { tenantId: "t", runId: "r", signal: new AbortController().signal };

  it("returns an on-demand skill whole, and only one the agent lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-"));
    await writeFile(
      join(dir, "derby.md"),
      "---\ndescription: Derbies\n---\nOpen with the rivalry.",
    );
    await writeFile(join(dir, "other.md"), "---\ndescription: Not this agent's\n---\nNo.");
    const tool = createSkillTool({
      skillsDir: dir,
      skills: ["preview"],
      onDemandSkills: ["derby"],
    });

    expect(await tool.run({ name: "derby" }, ctx)).toBe(
      "## Skill: derby\n\nOpen with the rivalry.",
    );
    expect(tool.alwaysInline).toBe(true);
    await expect(tool.run({ name: "other" }, ctx)).rejects.toThrow("no skill other");
    expect(await tool.run({ name: "preview" }, ctx)).toContain("already in your instructions");
  });
});
