import {
  type Answer,
  type Answers,
  type AskedQuestion,
  invalidAnswer,
  type Learned,
} from "@dugout/contracts";
import type { AnswerMemory } from "@dugout/core";
import { type Client, type Pool, toVector, withTenant } from "@dugout/db";
import type { EmbeddingClient } from "./embeddings.ts";

/**
 * What people answered when a run stopped to ask (ADR 0029), and what the harness does with it:
 *
 * - **Learn.** Consolidation records each answer a person gave. The same answer to the same
 *   question, asked in other words, adds to `times` instead of adding a row.
 * - **Prefill.** The next time the question is asked, the most recent answer that fits the
 *   question's options becomes its proposal, marked with how often it was given.
 * - **Stand.** A person can make an answer `standing` (`pnpm agent memory answers`). Only then does
 *   the harness answer the question itself, and it says so in the run (`source: memory`).
 *
 * It is per tenant: one club's domain or preference never reaches another's run.
 */

/** Cosine similarity above which two questions are the same question asked in other words. */
export const SAME_QUESTION = 0.88;

export interface LearnedAnswer {
  id: string;
  tenantId: string;
  agentId: string | null;
  question: string;
  kind: string;
  answer: Answer;
  times: number;
  firstAt: string;
  lastAt: string;
  standing: boolean;
  approvedBy: string | null;
  sourceRunId: string | null;
}

export interface AnswerReader {
  /** The most recent answer to this question that fits it, or undefined. */
  recallAnswer(tenantId: string, question: AskedQuestion): Promise<LearnedAnswer | undefined>;
  /** Every answer learned for the tenant, newest first. */
  listAnswers(tenantId: string): Promise<LearnedAnswer[]>;
}

export interface AnswerWriter {
  /** Records a person's answer: a repeat of one already learned adds to it. */
  recordAnswer(a: {
    tenantId: string;
    agentId: string;
    runId: string;
    question: AskedQuestion;
    answer: Answer;
  }): Promise<LearnedAnswer>;
  /** A person made the answer standing: later runs stop asking the question. */
  makeStanding(tenantId: string, id: string, reviewer: string): Promise<LearnedAnswer>;
  /** A person took the answer back. */
  forgetAnswer(tenantId: string, id: string): Promise<boolean>;
}

type Row = Record<string, unknown>;
const COLUMNS =
  "id, tenant_id, agent_id, question, kind, answer, times, first_at, last_at, standing, approved_by, source_run_id";
const toAnswer = (r: Row): LearnedAnswer => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  agentId: (r.agent_id as string | null) ?? null,
  question: r.question as string,
  kind: r.kind as string,
  answer: r.answer as Answer,
  times: Number(r.times),
  firstAt: new Date(r.first_at as string).toISOString(),
  lastAt: new Date(r.last_at as string).toISOString(),
  standing: r.standing as boolean,
  approvedBy: (r.approved_by as string | null) ?? null,
  sourceRunId: (r.source_run_id as string | null) ?? null,
});

export function createAnswerStore(opts: {
  pool: Pool;
  embeddings: EmbeddingClient;
}): AnswerReader & AnswerWriter {
  const { pool, embeddings } = opts;
  const tx = <T>(tenantId: string, fn: (db: Client) => Promise<T>) =>
    withTenant(pool, tenantId, fn);
  const embedOne = async (text: string) => toVector((await embeddings.embed([text]))[0] ?? []);

  const near = async (db: Client, tenantId: string, q: AskedQuestion, vector: string) => {
    const { rows } = await db.query(
      `select ${COLUMNS} from answer_memory
       where tenant_id = $1 and kind = $2 and 1 - (embedding <=> $3::vector) >= $4
       order by embedding <=> $3::vector limit 20`,
      [tenantId, q.kind, vector, SAME_QUESTION],
    );
    return rows.map(toAnswer);
  };

  return {
    async recallAnswer(tenantId, question) {
      if (question.kind === "review") return undefined;
      const vector = await embedOne(question.question);
      return tx(tenantId, async (db) => {
        const fits = (await near(db, tenantId, question, vector)).filter(
          (a) => invalidAnswer(question, a.answer) === undefined,
        );
        // the person's latest word on it
        return fits.sort((x, y) => y.lastAt.localeCompare(x.lastAt))[0];
      });
    },

    listAnswers: (tenantId) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `select ${COLUMNS} from answer_memory where tenant_id = $1 order by last_at desc`,
          [tenantId],
        );
        return rows.map(toAnswer);
      }),

    async recordAnswer({ tenantId, agentId, runId, question, answer }) {
      if (question.kind === "review") throw new Error("a review is not a question to learn from");
      const vector = await embedOne(question.question);
      return tx(tenantId, async (db) => {
        // the same answer to the same question: one more time, and the latest word
        const same = (await near(db, tenantId, question, vector)).find(
          (a) => JSON.stringify(a.answer) === JSON.stringify(answer),
        );
        if (same) {
          const { rows } = await db.query(
            `update answer_memory set times = times + 1, last_at = now(), source_run_id = $2
             where id = $1 returning ${COLUMNS}`,
            [same.id, runId],
          );
          return toAnswer(rows[0] as Row);
        }
        const { rows } = await db.query(
          `insert into answer_memory (tenant_id, agent_id, question, kind, answer, source_run_id, embedding)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7::vector) returning ${COLUMNS}`,
          [
            tenantId,
            agentId,
            question.question,
            question.kind,
            JSON.stringify(answer),
            runId,
            vector,
          ],
        );
        return toAnswer(rows[0] as Row);
      });
    },

    makeStanding: (tenantId, id, reviewer) =>
      tx(tenantId, async (db) => {
        const { rows } = await db.query(
          `update answer_memory set standing = true, approved_by = $3
           where id = $1 and tenant_id = $2 returning ${COLUMNS}`,
          [id, tenantId, reviewer],
        );
        if (!rows[0]) throw new Error("learned answer not found");
        return toAnswer(rows[0]);
      }),

    forgetAnswer: (tenantId, id) =>
      tx(tenantId, async (db) => {
        const { rowCount } = await db.query(
          "delete from answer_memory where id = $1 and tenant_id = $2",
          [id, tenantId],
        );
        return rowCount === 1;
      }),
  };
}

/** An answer as a question's `proposed`: a list of strings. */
export function asProposed(answer: Answer): string[] {
  if (Array.isArray(answer)) return answer;
  if (typeof answer === "boolean") return [answer ? "yes" : "no"];
  if (typeof answer === "object") return [];
  return [String(answer)];
}

/**
 * What a run knows from the answers before it, for the loop (ADR 0029): proposals taken from what a
 * person answered, and the answers of questions a person made standing.
 */
export function createAnswerMemory(store: AnswerReader, tenantId: string): AnswerMemory {
  return {
    async refine(questions) {
      return Promise.all(
        questions.map(async (q) => {
          const learned = await store.recallAnswer(tenantId, q);
          if (!learned) return q;
          const note: Learned = { times: learned.times, lastAt: learned.lastAt };
          return { ...q, proposed: asProposed(learned.answer), learned: note };
        }),
      );
    },
    async answer(questions) {
      const asked = questions.filter((q) => q.kind !== "review");
      if (asked.length === 0 || asked.length !== questions.length) return undefined;
      const answers: Answers = {};
      for (const q of asked) {
        const learned = await store.recallAnswer(tenantId, q);
        // only a person's standing answer, and only while it is still their latest word
        if (!learned?.standing) return undefined;
        answers[q.id] = learned.answer;
      }
      return answers;
    },
  };
}
