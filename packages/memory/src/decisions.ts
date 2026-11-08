import {
  type Answer,
  type Answers,
  type AskedQuestion,
  invalidAnswer,
  type Learned,
} from "@dugout/contracts";
import type { AnswerMemory } from "@dugout/core";
import { decisionKey, type MemoryItem, type MemoryReader, sameValue } from "./store.ts";

/**
 * What a run knows from what people answered before (ADR 0033), read from the memory there is: a
 * decision a person made on this section (episodic), then the club's house fact (semantic), active
 * and then proposed. Only a declared question is read (it says what it is about, `about`); others
 * are asked as they are.
 *
 * - **Propose.** The first of those that fits the question (its kind, its options) is its
 *   `proposed`, and `learned` says where it came from.
 * - **Answer.** A question is answered without asking only from an active fact, which a person
 *   approved, and only when no decision on this section differs from it.
 */
export function createDecisionMemory(
  reader: Pick<MemoryReader, "decision" | "fact">,
  tenantId: string,
): AnswerMemory {
  const decisionFor = (q: AskedQuestion) =>
    q.about?.scope === "section" && q.about.section
      ? reader.decision(tenantId, decisionKey(q.about.agent, q.id, q.about.section))
      : Promise.resolve(undefined);
  const factFor = (q: AskedQuestion, status: "active" | "proposed") =>
    q.about?.fact ? reader.fact(tenantId, q.about.fact, status) : Promise.resolve(undefined);
  const fits = (q: AskedQuestion, item: MemoryItem | undefined): item is MemoryItem =>
    item?.value !== undefined &&
    item.value !== null &&
    invalidAnswer(q, item.value as Answer) === undefined;

  return {
    async refine(questions) {
      return Promise.all(
        questions.map(async (q) => {
          if (!q.about || q.kind === "review") return q;
          const found: Array<[MemoryItem | undefined, Learned["from"]]> = [
            [await decisionFor(q), "decision"],
            [await factFor(q, "active"), "fact"],
            [await factFor(q, "proposed"), "fact"],
          ];
          const hit = found.find(([item]) => fits(q, item));
          if (!hit?.[0]) return q;
          const [item, from] = hit;
          const learned: Learned = { times: item.strength, lastAt: item.lastSeenAt, from };
          return { ...q, proposed: asProposed(item.value as Answer), learned };
        }),
      );
    },

    async answer(questions) {
      const asked = questions.filter((q) => q.kind !== "review");
      if (asked.length === 0 || asked.length !== questions.length) return undefined;
      const answers: Answers = {};
      for (const q of asked) {
        const fact = await factFor(q, "active");
        if (!fits(q, fact)) return undefined;
        // a person decided this section differently: the fact does not hold here, so ask
        const decided = await decisionFor(q);
        if (decided && !sameValue(decided.value, fact.value)) return undefined;
        answers[q.id] = fact.value as Answer;
      }
      return answers;
    },
  };
}

/** An answer as a question's `proposed`: a list of strings. */
export function asProposed(answer: Answer): string[] {
  if (Array.isArray(answer)) return answer;
  if (typeof answer === "boolean") return [answer ? "yes" : "no"];
  if (typeof answer === "object") return [];
  return [String(answer)];
}

/** An answer in words, for the sentence a decision or a fact is kept as. */
export function answerText(answer: unknown): string {
  if (Array.isArray(answer)) return answer.map(String).join(", ");
  if (typeof answer === "boolean") return answer ? "yes" : "no";
  if (typeof answer === "string" || typeof answer === "number") return String(answer);
  return JSON.stringify(answer);
}

/** At most this many earlier decisions are shown with a section. */
export const BEFORE_LIMIT = 10;
/** What `before` tells the model to do with them. */
export const BEFORE_RULE =
  "A person already decided these about this section in earlier runs. Keep to them: do not ask them again, and say in remaining where the frame or the data now makes one wrong.";

/**
 * What people decided about a section before (ADR 0033), as the lines a load tool returns: the
 * date, the agent and the question, and the sentence it was kept as. Read with the run's verified
 * tenant, never from the model. Empty when there is none, or no reader.
 */
export async function decidedBefore(
  reader: Pick<MemoryReader, "decisionsOn"> | undefined,
  tenantId: string,
  section: string | undefined,
): Promise<string[]> {
  if (!reader || !section) return [];
  const decided = await reader.decisionsOn(tenantId, section, BEFORE_LIMIT);
  return decided.map((d) => {
    const question = (d.key ?? "").split("@")[0] ?? "";
    return `${d.lastSeenAt.slice(0, 10)} ${question.replace(":", " ")}: ${answerText(d.value)}. ${d.content}`;
  });
}
