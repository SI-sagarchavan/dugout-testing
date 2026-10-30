import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@dugout/contracts";
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
  type MemoryStore,
  rankEpisodes,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store: MemoryStore = createMemoryStore({ pool, embeddings: createHashEmbeddings() });
const AGENT = "match-preview";

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
  agentId: string | null = AGENT,
) => {
  const p = await store.proposeFact({
    tenantId,
    agentId,
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
) =>
  store.addEpisode({
    tenantId,
    agentId: AGENT,
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

    const searchB = await store.search({
      tenantId: b,
      agentId: AGENT,
      query: "betting odds British spelling",
    });
    expect(searchB).toEqual([]);
    expect(await store.activeFacts(b, AGENT)).toEqual([]);
    expect(await store.history(b, AGENT, "style.spelling")).toEqual([]);
    await expect(store.activateFact(b, own.id, "intruder")).rejects.toThrow("not found");
    await expect(store.rejectProposal(b, own.id, "intruder")).rejects.toThrow("not found");
    expect(await store.deleteBySourceRun(b, own.sourceRunId ?? "none")).toBe(0);
  });

  it("scopes the memory.search tool by the run's tenant, not by its input", async () => {
    await episode(a, "Never mention the toss result");
    const [search] = createMemoryTools({ reader: store, agentId: AGENT });
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

describe("tenant-wide facts", () => {
  const contents = (items: Array<{ key: string | null; content: string }>) =>
    items.map((f) => `${f.key}: ${f.content}`);

  it("are shared by every agent, and an agent's own fact wins on its key", async () => {
    await fact(a, "style.spelling", "Use British English", null);
    await fact(a, "audience", "Cricket fans", null);
    await fact(a, "audience", "Club members", AGENT);

    expect(contents(await store.activeFacts(a, AGENT))).toEqual([
      "audience: Club members",
      "style.spelling: Use British English",
    ]);
    expect(contents(await store.activeFacts(a, "sitemap"))).toEqual([
      "audience: Cricket fans",
      "style.spelling: Use British English",
    ]);
    // the tenant's facts alone
    expect(contents(await store.activeFacts(a, null))).toEqual([
      "audience: Cricket fans",
      "style.spelling: Use British English",
    ]);
    expect(await store.activeFacts(b, AGENT)).toEqual([]);
  });

  it("are versioned apart from an agent's fact with the same key", async () => {
    await fact(a, "style.length", "At most 120 words", null);
    await fact(a, "style.length", "At most 100 words", null);
    await fact(a, "style.length", "At most 80 words", AGENT);

    expect(
      (await store.history(a, null, "style.length")).map((h) => [h.version, h.status]),
    ).toEqual([
      [1, "retired"],
      [2, "active"],
    ]);
    expect((await store.history(a, AGENT, "style.length")).map((h) => h.version)).toEqual([1]);
    expect(contents(await store.activeFacts(a, null))).toEqual(["style.length: At most 100 words"]);
  });

  it("are found by every agent's search, while episodes stay with their agent", async () => {
    await fact(a, "style.spelling", "Use British English spelling", null);
    await episode(a, "A reviewer asked for British spelling in the headline");

    const found = await store.search({
      tenantId: a,
      agentId: "sitemap",
      query: "British spelling",
    });
    expect(found.map((f) => f.content)).toEqual(["Use British English spelling"]);
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

  it("rank a recent, strengthened lesson above an older one that matches as well", () => {
    const now = new Date("2026-10-30T00:00:00Z");
    const ranked = rankEpisodes(
      [
        { id: "old", score: 0.03, strength: 1, lastSeenAt: "2026-07-01T00:00:00Z" },
        { id: "recent", score: 0.029, strength: 3, lastSeenAt: "2026-10-29T00:00:00Z" },
        { id: "irrelevant", score: 0.005, strength: 5, lastSeenAt: "2026-10-30T00:00:00Z" },
      ],
      now,
    );
    expect(ranked.map((r) => r.id)).toEqual(["recent", "old", "irrelevant"]);
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

describe("hybrid search", () => {
  it("ranks items matching on both text and vector first, and skips expired episodes", async () => {
    await episode(a, "Spell kickoff times in 24-hour format");
    await episode(a, "Avoid the word clash in headlines");
    await episode(a, "Old rule: no clash in a headline", -1);
    const results = await store.search({
      tenantId: a,
      agentId: AGENT,
      query: "headline word clash",
    });
    expect(results[0]?.content).toBe("Avoid the word clash in headlines");
    expect(results.map((r) => r.content)).not.toContain("Old rule: no clash in a headline");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("survives queries with tsquery syntax in them", async () => {
    await episode(a, "Mention the venue");
    const results = await store.search({ tenantId: a, agentId: AGENT, query: "venue' & ! (:*" });
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
    expect((await store.activeFacts(a, AGENT)).map((f) => f.content)).toEqual([
      "At most 120 words",
    ]);
    const search = await store.search({ tenantId: a, agentId: AGENT, query: "100 words" });
    expect(search.map((s) => s.content)).not.toContain("At most 100 words");

    await store.activateFact(a, proposal.id, "editor");
    expect((await store.activeFacts(a, AGENT)).map((f) => f.content)).toEqual([
      "At most 100 words",
    ]);
    const history = await store.history(a, AGENT, "style.max-words");
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
    expect((await store.history(a, AGENT, "k"))[0]?.status).toBe("retired");
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

  it("proposes a tenant-wide fact when the agent asks for that scope", async () => {
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
          input: {
            key: "audience",
            content: "Readers are T20 fans",
            confidence: 0.8,
            scope: "tenant",
          },
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
    expect(out.proposals[0]).toMatchObject({ key: "audience", agentId: null, status: "proposed" });
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
    expect(full.text).toContain("## Similar past runs");
    expect(full.text).toContain("Input preview headline: completed.");
    expect(full.sources.map((s) => s.kind)).toEqual([
      "procedural",
      "semantic",
      "semantic",
      "episodic",
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
