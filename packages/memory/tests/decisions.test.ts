import { randomUUID } from "node:crypto";
import { type AskedQuestion, FROM_MEMORY, type RunEvent } from "@dugout/contracts";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  consolidateRun,
  createDecisionMemory,
  createHashEmbeddings,
  createMemoryStore,
  decisionKey,
  EPISODE_TTL_DAYS,
  type MemoryStore,
  PROMOTE_SECTIONS,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store: MemoryStore = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

let a: string;
let b: string;
beforeEach(() => {
  const suffix = randomUUID().slice(0, 8);
  a = `t-a-${suffix}`;
  b = `t-b-${suffix}`;
});

const SB = "https://www.southernbrave.com";
const SECTION = "sig-player-carousel";

/** hook-maker's hook choice, asked about one section. */
const hookChoice = (over: Partial<AskedQuestion> = {}): AskedQuestion => ({
  id: "hook_choice",
  question: "Use the hook that was found, or build a fuller one?",
  why: "The hook gives most of the card",
  kind: "choice",
  options: [
    { value: "use_existing", label: "Use it", description: "" },
    { value: "build", label: "Build a fuller one", description: "" },
  ],
  allowOther: false,
  proposed: ["build"],
  about: { agent: "hook-maker", scope: "section", section: SECTION, name: "Frame 1984078918" },
  ...over,
});

/** data-bind's image domain, about the club. */
const domain = (over: Partial<AskedQuestion> = {}): AskedQuestion => ({
  id: "image_domain",
  question: "Which domain serves the CMS images?",
  why: "The hook's image paths are relative",
  kind: "text",
  options: [],
  allowOther: false,
  proposed: [],
  about: { agent: "data-bind", scope: "tenant", fact: "media.image-domain" },
  ...over,
});

const decide = (tenantId: string, q: AskedQuestion, value: unknown, section = SECTION) =>
  store.recordDecision({
    tenantId,
    agentId: q.about?.agent ?? "x",
    key: decisionKey(q.about?.agent ?? "x", q.id, section),
    value,
    content: `decided ${String(value)}`,
    sourceRunId: randomUUID(),
    ttlDays: EPISODE_TTL_DAYS,
  });

const fact = async (tenantId: string, key: string, value: unknown, active: boolean) => {
  const proposed = await store.proposeFact({
    tenantId,
    agentId: null,
    key,
    content: `${key}: ${String(value)}`,
    confidence: 1,
    sourceRunId: null,
    value,
  });
  return active ? store.activateFact(tenantId, proposed.id, "sagar") : proposed;
};

describe("decisions in the store (ADR 0033)", () => {
  it("strengthens the same answer, keeps a changed one as the latest, and never another tenant's", async () => {
    const first = await decide(a, hookChoice(), "use_existing");
    expect(first).toMatchObject({ reinforced: false, strength: 1, value: "use_existing" });
    const again = await decide(a, hookChoice(), "use_existing");
    expect(again).toMatchObject({ id: first.id, reinforced: true, strength: 2 });
    await new Promise((r) => setTimeout(r, 20));
    const changed = await decide(a, hookChoice(), "build");
    expect(changed.id).not.toBe(first.id);

    const key = decisionKey("hook-maker", "hook_choice", SECTION);
    expect((await store.decision(a, key))?.value).toBe("build");
    expect(await store.decision(b, key)).toBeUndefined();
    // the latest per question on the section
    expect((await store.decisionsOn(a, SECTION)).map((d) => d.value)).toEqual(["build"]);
    expect(await store.decisionsOn(a, "another-section")).toEqual([]);
  });

  it("counts the sections whose latest decision is an answer", async () => {
    await decide(a, hookChoice(), "use_existing", "s1");
    await decide(a, hookChoice(), "use_existing", "s2");
    await decide(a, hookChoice(), "build", "s3");
    expect(
      await store.sectionsAnswered(a, "hook-maker", "hook_choice", "use_existing"),
    ).toHaveLength(2);
    expect(
      await store.sectionsAnswered(a, "data-bind", "hook_choice", "use_existing"),
    ).toHaveLength(0);
  });

  it("keeps a fact's value, and a person can revise a proposal before approving it", async () => {
    const proposed = await fact(a, "media.player-photo", "https://x/players/4661.png", false);
    const revised = await store.reviseProposal(a, proposed.id, {
      content: "Player photos: https://x/players/{id}.png",
      value: "https://x/players/{id}.png",
    });
    expect(revised).toMatchObject({ status: "proposed", value: "https://x/players/{id}.png" });
    expect((await store.fact(a, "media.player-photo", "proposed"))?.id).toBe(proposed.id);
    expect(await store.fact(a, "media.player-photo", "active")).toBeUndefined();
    await store.activateFact(a, proposed.id, "sagar");
    expect((await store.fact(a, "media.player-photo", "active"))?.value).toBe(
      "https://x/players/{id}.png",
    );
  });
});

describe("what a run is proposed and answered from memory (ADR 0033)", () => {
  it("proposes this section's decision first, then the active fact, then a proposed one", async () => {
    const memory = createDecisionMemory(store, a);
    const asked = domain({
      about: { agent: "data-bind", scope: "section", fact: "media.image-domain", section: SECTION },
    });
    expect((await memory.refine([asked]))[0]).toEqual(asked);

    await fact(a, "media.image-domain", "https://proposed.example", false);
    expect((await memory.refine([asked]))[0]).toMatchObject({
      proposed: ["https://proposed.example"],
      learned: { from: "fact" },
    });
    await fact(a, "media.image-domain", SB, true);
    expect((await memory.refine([asked]))[0]?.proposed).toEqual([SB]);
    await decide(a, asked, "https://this-section.example");
    expect((await memory.refine([asked]))[0]).toMatchObject({
      proposed: ["https://this-section.example"],
      learned: { from: "decision", times: 1 },
    });
  });

  it("reads a decision only on its own section, and leaves undeclared questions alone", async () => {
    await decide(a, hookChoice(), "use_existing", "other-section");
    const memory = createDecisionMemory(store, a);
    expect((await memory.refine([hookChoice()]))[0]?.proposed).toEqual(["build"]);
    const { about: _about, ...undeclared } = hookChoice();
    await decide(a, hookChoice(), "use_existing");
    expect((await memory.refine([undeclared]))[0]).toEqual(undeclared);
    // a remembered answer that is not one of this question's options is not offered
    const narrower = hookChoice({
      options: [
        { value: "build", label: "Build", description: "" },
        { value: "skip", label: "Skip", description: "" },
      ],
    });
    expect((await memory.refine([narrower]))[0]?.proposed).toEqual(["build"]);
  });

  it("answers without asking only from an active fact no decision on this section contradicts", async () => {
    const memory = createDecisionMemory(store, a);
    await fact(a, "media.image-domain", SB, false);
    expect(await memory.answer([domain()])).toBeUndefined();
    await fact(a, "media.image-domain", SB, true);
    expect(await memory.answer([domain()])).toEqual({ image_domain: SB });
    // every question of the pause must be answered by a fact: one that is not is asked
    expect(await memory.answer([domain(), hookChoice()])).toBeUndefined();

    const sectioned = domain({
      about: { agent: "data-bind", scope: "section", fact: "media.image-domain", section: SECTION },
    });
    expect(await memory.answer([sectioned])).toEqual({ image_domain: SB });
    await decide(a, sectioned, "https://elsewhere.example");
    expect(await memory.answer([sectioned])).toBeUndefined();
  });
});

describe("consolidation learns from answers (ADR 0033)", () => {
  const ev = (seq: number, type: string, data: unknown) =>
    ({ runId: "r", seq, at: "2026-11-06T00:00:00Z", type, data }) as RunEvent;
  const asked = (callId: string, questions: AskedQuestion[]) =>
    ev(2, "question.asked", { step: 1, callId, tool: "ask", questions, from: [] });
  const answered = (callId: string, by: string, source: string, answers: unknown) =>
    ev(3, "question.answered", { step: 1, callId, tool: "ask", by, answers, source });
  const started = ev(1, "run.started", {
    agentId: "section-builder",
    agentVersion: 1,
    tenantId: "x",
    input: { handoffId: "h" },
  });
  const done = ev(9, "run.completed", { status: "completed", output: null, usage: {} });
  const learn = (tenantId: string, events: RunEvent[], learnsAnswers = true) =>
    consolidateRun({
      writer: store,
      tenantId,
      agentId: "section-builder",
      runId: randomUUID(),
      events,
      learnsAnswers,
    });
  const key = decisionKey("hook-maker", "hook_choice", SECTION);

  it("keeps a section answer as a decision of the agent that asked, and nothing a host, the agent or memory answered", async () => {
    const mine = await learn(a, [
      started,
      asked("c1", [hookChoice()]),
      answered("c1", "sagar", "person", { hook_choice: "use_existing" }),
      done,
    ]);
    expect(mine.decisions).toHaveLength(1);
    expect(await store.decision(a, key)).toMatchObject({
      agentId: "hook-maker",
      value: "use_existing",
      strength: 1,
    });

    for (const [by, source] of [
      ["sagar", "agent"],
      ["watch (auto)", "auto"],
      [FROM_MEMORY, "memory"],
    ]) {
      await learn(a, [
        started,
        asked("c2", [hookChoice()]),
        answered("c2", by as string, source as string, { hook_choice: "build" }),
        done,
      ]);
    }
    expect((await store.decision(a, key))?.value).toBe("use_existing");

    // skipped, or asked in a child run (learned where a person answered it): nothing
    await learn(a, [
      started,
      asked("c3", [hookChoice()]),
      answered("c3", "sagar", "person", {}),
      done,
    ]);
    await learn(
      a,
      [
        started,
        asked("c4", [hookChoice()]),
        answered("c4", "sagar", "person", { hook_choice: "use_existing" }),
        done,
      ],
      false,
    );
    expect((await store.decision(a, key))?.strength).toBe(1);

    // an undeclared question, and a section question asked before the run knew its section
    const { about: _about, ...undeclared } = hookChoice();
    const unplaced = hookChoice({ about: { agent: "hook-maker", scope: "section" } });
    const none = await learn(a, [
      started,
      asked("c5", [undeclared, { ...unplaced, id: "card_template" }]),
      answered("c5", "sagar", "person", { hook_choice: "build", card_template: "x" }),
      done,
    ]);
    expect(none.decisions).toEqual([]);
  });

  it("proposes a club answer as a fact once, and a section answer once enough sections share it", async () => {
    const first = await learn(a, [
      started,
      asked("c1", [domain()]),
      answered("c1", "sagar", "person", { image_domain: SB }),
      done,
    ]);
    expect(first.proposals).toMatchObject([{ key: "media.image-domain", value: SB }]);
    const again = await learn(a, [
      started,
      asked("c2", [domain()]),
      answered("c2", "sagar", "person", { image_domain: SB }),
      done,
    ]);
    expect(again.proposals).toEqual([]);

    const loop = (section: string): AskedQuestion => ({
      id: "loop",
      question: "Wrap around after the last item?",
      why: "The frame cannot show it",
      kind: "confirm",
      options: [],
      allowOther: false,
      proposed: ["yes"],
      about: { agent: "frame-match", scope: "section", fact: "layout.carousel.loop", section },
    });
    const proposals = [];
    for (let i = 1; i <= PROMOTE_SECTIONS + 1; i++) {
      const out = await learn(a, [
        started,
        asked(`l${i}`, [loop(`s${i}`)]),
        answered(`l${i}`, "sagar", "person", { loop: true }),
        done,
      ]);
      proposals.push(...out.proposals);
    }
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ key: "layout.carousel.loop", value: true });
    expect(proposals[0]?.sources).toHaveLength(PROMOTE_SECTIONS);
  });

  it("redacts what it stores, and never learns a write's review", async () => {
    await learn(a, [
      started,
      asked("c1", [domain()]),
      answered("c1", "sagar", "person", { image_domain: "write to jo@example.org" }),
      ev(4, "question.asked", {
        step: 2,
        callId: "w1",
        tool: "draft.save",
        questions: [{ ...domain(), id: "review", kind: "review" }],
        from: [],
        subject: { input: {} },
      }),
      ev(5, "question.answered", {
        step: 2,
        callId: "w1",
        tool: "draft.save",
        by: "sagar",
        source: "person",
        answers: { review: { decision: "approve" } },
      }),
      done,
    ]);
    const proposed = await store.fact(a, "media.image-domain", "proposed");
    expect(proposed?.value).not.toContain("jo@example.org");
    expect(proposed?.content).not.toContain("jo@example.org");
    expect((await store.listProposals(a)).map((p) => p.key)).toEqual(["media.image-domain"]);
  });
});
