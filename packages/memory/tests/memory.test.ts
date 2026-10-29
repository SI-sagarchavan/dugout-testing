import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@dugout/contracts";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  buildContext,
  consolidateRun,
  createHashEmbeddings,
  createMemoryStore,
  createMemoryTools,
  estimateTokens,
  type MemoryStore,
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

const fact = async (tenantId: string, key: string, content: string) => {
  const p = await store.proposeFact({
    tenantId,
    agentId: AGENT,
    key,
    content,
    confidence: 1,
    sourceRunId: null,
  });
  return store.activateFact(tenantId, p.id, "seed");
};
const episode = (tenantId: string, content: string, ttlDays = 30, sourceRunId = randomUUID()) =>
  store.addEpisode({ tenantId, agentId: AGENT, content, confidence: 0.9, sourceRunId, ttlDays });

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

describe("hybrid search", () => {
  it("ranks items matching on both text and vector first, and skips expired episodes", async () => {
    await episode(a, "Spell kickoff times in 24-hour format");
    await episode(a, "Avoid the word clash in headlines");
    await episode(a, "Avoid the word clash in headlines, expired", -1);
    const results = await store.search({
      tenantId: a,
      agentId: AGENT,
      query: "headline word clash",
    });
    expect(results[0]?.content).toBe("Avoid the word clash in headlines");
    expect(results.map((r) => r.content)).not.toContain(
      "Avoid the word clash in headlines, expired",
    );
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
      sourceRunId: runId,
    });
    expect(await store.deleteBySourceRun(a, runId)).toBe(2);
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
});

describe("context builder", () => {
  it("loads skills with tenant overrides, then facts, then episodes, within the budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-"));
    await writeFile(join(dir, "preview.md"), "Write a preview.");
    await mkdir(join(dir, "tenants", a), { recursive: true });
    await writeFile(join(dir, "tenants", a, "preview.md"), "Cricket audience.");
    await fact(a, "style.a", "Fact one about spelling");
    await fact(a, "style.b", "Fact two about word limits");
    for (let i = 0; i < 5; i++) await episode(a, `Lesson ${i} about the preview headline`);

    const full = await buildContext({
      reader: store,
      skillsDir: dir,
      skills: ["preview"],
      tenantId: a,
      agentId: AGENT,
      query: "preview headline",
      budgetTokens: 10_000,
      readSemantic: true,
      readEpisodic: true,
    });
    expect(full.text).toContain("### Tenant notes\n\nCricket audience.");
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

    const tight = await buildContext({
      reader: store,
      skillsDir: dir,
      skills: ["preview"],
      tenantId: a,
      agentId: AGENT,
      query: "preview headline",
      budgetTokens: 60,
      readSemantic: true,
      readEpisodic: true,
    });
    expect(tight.tokens).toBeLessThanOrEqual(60);
    expect(estimateTokens(tight.text)).toBeLessThanOrEqual(60);
    expect(tight.sources.length).toBeLessThan(full.sources.length);
    expect(tight.sources[0]?.kind).toBe("procedural");
  });
});
