import { randomUUID } from "node:crypto";
import { type AskedQuestion, FROM_MEMORY, type RunEvent } from "@dugout/contracts";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  consolidateRun,
  createAnswerMemory,
  createHashEmbeddings,
  createMemoryStore,
  type MemoryStore,
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

const SB = "https://www.southernbrave.co.uk";
const domain = (over: Partial<AskedQuestion> = {}): AskedQuestion => ({
  id: "image_domain",
  question: "Which domain serves the CMS images?",
  why: "The hook's image paths are relative",
  kind: "choice",
  options: [
    { value: SB, label: "southernbrave.co.uk", description: "" },
    { value: "https://cdn.example.com", label: "cdn.example.com", description: "" },
  ],
  allowOther: true,
  proposed: [],
  ...over,
});
const record = (tenantId: string, question: AskedQuestion, answer: string | boolean | number) =>
  store.recordAnswer({ tenantId, agentId: "data-bind", runId: randomUUID(), question, answer });

describe("learned answers (ADR 0029)", () => {
  it("adds to a count when the same question is answered the same way again", async () => {
    const first = await record(a, domain(), SB);
    expect(first).toMatchObject({ times: 1, standing: false, answer: SB });
    const again = await record(a, domain(), SB);
    expect(again.id).toBe(first.id);
    expect(again.times).toBe(2);
    // another answer to the same question is its own row
    const other = await record(a, domain(), "https://cdn.example.com");
    expect(other.id).not.toBe(first.id);
    expect(await store.listAnswers(a)).toHaveLength(2);
  });

  it("recalls the person's latest answer that fits the question, never another tenant's", async () => {
    await record(a, domain(), SB);
    await new Promise((r) => setTimeout(r, 20));
    await record(a, domain(), "https://cdn.example.com");
    expect((await store.recallAnswer(a, domain()))?.answer).toBe("https://cdn.example.com");
    expect(await store.recallAnswer(b, domain())).toBeUndefined();
    // an answer that is not one of this question's options (and no other allowed) is not offered
    const closed = domain({
      allowOther: false,
      options: [
        { value: SB, label: "sb", description: "" },
        { value: "x", label: "x", description: "" },
      ],
    });
    expect((await store.recallAnswer(a, closed))?.answer).toBe(SB);
    // a different kind of question is a different question
    expect(await store.recallAnswer(a, domain({ kind: "text", options: [] }))).toBeUndefined();
  });

  it("puts what was learned into a question's proposal, and says how often", async () => {
    await record(a, domain(), SB);
    await record(a, domain(), SB);
    const memory = createAnswerMemory(store, a);
    const [refined] = await memory.refine([domain({ proposed: ["https://cdn.example.com"] })]);
    expect(refined).toMatchObject({ proposed: [SB], learned: { times: 2 } });
    // a question it knows nothing about is left as the agent wrote it
    const fresh = domain({
      question: "How many cards should the strip show on a phone?",
      kind: "number",
      options: [],
      allowOther: false,
      proposed: ["3"],
    });
    expect((await memory.refine([fresh]))[0]).toEqual(fresh);
    // a review is never refined
  });

  it("answers for the person only once they made the answer standing, and only while it is their latest word", async () => {
    const learned = await record(a, domain(), SB);
    const memory = createAnswerMemory(store, a);
    expect(await memory.answer([domain()])).toBeUndefined();

    await store.makeStanding(a, learned.id, "sagar");
    expect(await memory.answer([domain()])).toEqual({ image_domain: SB });
    // every question of the pause must be standing: one that is not is asked
    const other = domain({
      id: "cards",
      question: "How many cards?",
      kind: "number",
      options: [],
      allowOther: false,
    });
    expect(await memory.answer([domain(), other])).toBeUndefined();

    // the person changes their mind: the newer answer is not standing, so the question is asked again
    await new Promise((r) => setTimeout(r, 20));
    await record(a, domain(), "https://cdn.example.com");
    expect(await memory.answer([domain()])).toBeUndefined();
    expect((await memory.refine([domain()]))[0]?.proposed).toEqual(["https://cdn.example.com"]);

    // and a person can take an answer back
    expect(await store.forgetAnswer(a, learned.id)).toBe(true);
    expect((await store.listAnswers(a)).map((x) => x.answer)).toEqual(["https://cdn.example.com"]);
  });
});

describe("consolidation learns from answers (ADR 0029)", () => {
  const ev = (seq: number, type: string, data: unknown) =>
    ({ runId: "r", seq, at: "2026-11-06T00:00:00Z", type, data }) as RunEvent;
  const asked = (callId: string) =>
    ev(2, "question.asked", { step: 1, callId, tool: "ask", questions: [domain()], from: [] });
  const answered = (callId: string, by: string, source: string, answers: unknown) =>
    ev(3, "question.answered", { step: 1, callId, tool: "ask", by, answers, source });
  const started = ev(1, "run.started", {
    agentId: "data-bind",
    agentVersion: 1,
    tenantId: "x",
    input: { handoffId: "h" },
  });
  const done = ev(9, "run.completed", { status: "completed", output: null, usage: {} });
  const learn = (tenantId: string, events: RunEvent[]) =>
    consolidateRun({ writer: store, tenantId, agentId: "data-bind", runId: randomUUID(), events });

  it("learns what a person chose, and nothing a host, the agent or memory answered", async () => {
    const mine = await learn(a, [
      started,
      asked("c1"),
      answered("c1", "sagar", "person", { image_domain: SB }),
      done,
    ]);
    expect(mine.answers).toHaveLength(1);
    expect(await store.listAnswers(a)).toMatchObject([
      { answer: SB, times: 1, agentId: "data-bind" },
    ]);

    // the agent's own proposals, taken because the person let it decide, are not the person's words
    await learn(a, [
      started,
      asked("c2"),
      answered("c2", "sagar", "agent", { image_domain: "https://cdn.example.com" }),
      done,
    ]);
    await learn(a, [
      started,
      asked("c3"),
      answered("c3", "watch (auto)", "auto", { image_domain: "https://cdn.example.com" }),
      done,
    ]);
    await learn(a, [
      started,
      asked("c4"),
      answered("c4", FROM_MEMORY, "memory", { image_domain: "https://cdn.example.com" }),
      done,
    ]);
    expect(await store.listAnswers(a)).toHaveLength(1);

    // a question the person skipped has no answer to learn
    await learn(a, [started, asked("c5"), answered("c5", "sagar", "person", {}), done]);
    expect(await store.listAnswers(a)).toHaveLength(1);

    // answering it the same way again is one more time
    await learn(a, [
      started,
      asked("c6"),
      answered("c6", "sagar", "person", { image_domain: SB }),
      done,
    ]);
    expect((await store.listAnswers(a))[0]?.times).toBe(2);
  });

  it("redacts what it stores, and never learns a write's review", async () => {
    await learn(a, [
      started,
      asked("c1"),
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
        answers: { review: { decision: "approve" } },
        source: "person",
      }),
      done,
    ]);
    const rows = await store.listAnswers(a);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("example.org");
  });
});
