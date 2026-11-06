import { z } from "zod";

/**
 * A run stopping for a person (ADR 0029). There is one kind of pause. A run that waits holds one or
 * more questions, answered one by one and submitted together, and optionally the tool call they are
 * about. A write that needs a yes is a pause with one question of kind `review`; the agent's own
 * questions are the other kinds. The FanXP backend and the admin app mirror these shapes: they are
 * defined once, here.
 *
 * Every array is required (`[]` when empty): with strict tools Bedrock never writes an optional
 * array of objects, so an optional `options` could not be sent at all.
 */

/** What the model may ask. A `review` is the harness's own: it is never the model's to write. */
export const QUESTION_KINDS = ["choice", "multi", "text", "confirm", "number"] as const;
export const REVIEW_ID = "review";

export const QuestionOption = z.object({
  value: z.string().min(1).describe("What the answer is, as the run reads it"),
  label: z.string().min(1).describe("What the person reads"),
  description: z
    .string()
    .describe("What choosing it means, in a sentence; empty when the label says it all"),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** A question as the model writes it. */
export const Question = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .describe(
      "A short id for the answer, unique in this ask: lower case, digits and _ (image_domain)",
    ),
  question: z.string().min(1).describe("The question, as the person reads it"),
  why: z
    .string()
    .min(1)
    .describe("What you found that makes you ask: the evidence, in a sentence or two"),
  kind: z
    .enum(QUESTION_KINDS)
    .describe(
      "choice: pick one option. multi: pick any of the options. text: free text. confirm: yes or no. number: a number",
    ),
  options: z
    .array(QuestionOption)
    .describe(
      "For choice and multi, the answers to pick from (two or more). [] for the other kinds",
    ),
  allowOther: z
    .boolean()
    .describe(
      "For choice and multi: the person may answer outside the options, in their own words",
    ),
  proposed: z
    .array(z.string())
    .describe(
      "Your best answer, which the person can accept as it is: one option value (several for multi), 'yes' or 'no' for confirm, the text, or the number as text. [] when you have none",
    ),
});
export type Question = z.infer<typeof Question>;

/** What the harness found in memory about a question: a person has answered it this way before. */
export const Learned = z.object({
  times: z.number().int().positive().describe("How many earlier runs a person answered it so"),
  lastAt: z.string().describe("When, ISO 8601"),
});
export type Learned = z.infer<typeof Learned>;

/**
 * A question as a host shows it: the model's, with `proposed` possibly replaced by what a person
 * answered before (`learned`), or the harness's `review` of a write.
 */
export const AskedQuestion = Question.extend({
  kind: z.enum([...QUESTION_KINDS, "review"]),
  learned: Learned.optional(),
});
export type AskedQuestion = z.infer<typeof AskedQuestion>;

/** The tool call a pause is about, when it is one: a write waiting for a yes. */
export const Subject = z.object({ input: z.unknown() });
export type Subject = z.infer<typeof Subject>;

const ID = /^[a-z][a-z0-9_]*$/;

export const AskInput = z
  .object({
    questions: z
      .array(Question)
      .min(1)
      .max(8)
      .describe("Everything you need to know now, all at once: the person answers them together"),
  })
  .superRefine(({ questions }, ctx) => {
    const seen = new Set<string>();
    questions.forEach((q, i) => {
      const at = (message: string) =>
        ctx.addIssue({ code: "custom", path: ["questions", i], message });
      if (!ID.test(q.id)) {
        at(`id ${JSON.stringify(q.id)}: lower case, digits and _, starting with a letter`);
      }
      if (q.id === REVIEW_ID) at(`id ${REVIEW_ID} is reserved`);
      if (seen.has(q.id)) at(`id ${q.id} is used twice`);
      seen.add(q.id);
      const picks = q.kind === "choice" || q.kind === "multi";
      if (picks && q.options.length < 2 && !q.allowOther) {
        at(`${q.id} is a ${q.kind}: give two or more options, or allowOther`);
      }
      if (!picks && q.options.length > 0) {
        at(`${q.id} is ${q.kind}: options are for choice and multi`);
      }
      if (q.kind !== "multi" && q.proposed.length > 1) at(`${q.id}: only multi proposes several`);
      if (q.kind === "confirm" && q.proposed.some((p) => !/^(yes|no)$/i.test(p.trim()))) {
        at(`${q.id} is confirm: propose 'yes' or 'no'`);
      }
      const problem = q.proposed.length > 0 ? invalidAnswer(q, proposedValue(q)) : undefined;
      if (problem) at(`${q.id}: the proposal ${problem}`);
    });
  });
export type AskInput = z.infer<typeof AskInput>;

export const REVIEW_DECISIONS = ["approve", "change", "reject"] as const;

/** The answer to a `review`: approve the write, send it back with a change, or reject it. */
export const ReviewAnswer = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  comment: z.string().optional().describe("Required for change (what to change) and reject (why)"),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

/** One answer: an option value or the person's own words, several for multi, yes/no, a number. */
export const Answer = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  ReviewAnswer,
]);
export type Answer = z.infer<typeof Answer>;

/** The answers to one pause, by question id. A question left out is skipped. */
export const Answers = z.record(z.string(), Answer);
export type Answers = z.infer<typeof Answers>;

/**
 * What a host sends to a waiting run, and stores on it: who, and the answers. Answers it leaves
 * out are skipped (the agent decides those, and says so). With no `answers` at all the person lets
 * the agent decide everything: each question's proposed answer is used. A `review` has no
 * proposal, so it always needs its answer. A pause is only ever ended by cancelling the run.
 */
export interface Decision {
  by: string;
  answers?: Answers;
}

export const approve = (by: string): Decision => ({
  by,
  answers: { [REVIEW_ID]: { decision: "approve" } },
});
export const reject = (by: string, reason: string): Decision => ({
  by,
  answers: { [REVIEW_ID]: { decision: "reject", comment: reason } },
});
export const requestChange = (by: string, changes: string): Decision => ({
  by,
  answers: { [REVIEW_ID]: { decision: "change", comment: changes } },
});

/** The harness's question for a write: approve it, ask for a change, or reject it. */
export function reviewQuestion(tool: string): AskedQuestion {
  return {
    id: REVIEW_ID,
    question: `Approve ${tool}?`,
    why: `${tool} writes. It runs only when a person approves it.`,
    kind: "review",
    options: [
      { value: "approve", label: "Approve", description: "Run it as shown" },
      {
        value: "change",
        label: "Request a change",
        description: "Send it back to the agent in this run, with what to change",
      },
      { value: "reject", label: "Reject", description: "Do not run it, and stop the run" },
    ],
    allowOther: false,
    proposed: [],
  };
}

/** A question's proposal as the answer it would be, for a host that accepts the proposals. */
export function proposedValue(q: Pick<AskedQuestion, "kind" | "proposed">): Answer {
  if (q.kind === "multi") return [...q.proposed];
  const [first = ""] = q.proposed;
  if (q.kind === "confirm") return first.trim().toLowerCase() === "yes";
  if (q.kind === "number") return Number(first);
  return first;
}

/** Each question's proposal; a question with none is left out. */
export function proposedAnswers(questions: readonly AskedQuestion[]): Answers {
  return Object.fromEntries(
    questions
      .filter((q) => q.kind !== "review" && q.proposed.length > 0)
      .map((q) => [q.id, proposedValue(q)]),
  );
}

/** What is wrong with `value` as the answer to `q`, or undefined when it fits. */
export function invalidAnswer(q: AskedQuestion, value: Answer): string | undefined {
  const values = q.options.map((o) => o.value);
  const known = (v: string) => values.includes(v) || q.allowOther;
  switch (q.kind) {
    case "choice":
      if (typeof value !== "string" || !value.trim()) return "is not one answer";
      return known(value) ? undefined : `is not one of ${values.join(", ")}`;
    case "multi":
      if (!Array.isArray(value)) return "is not a list";
      return value.every(known) ? undefined : `has an answer outside ${values.join(", ")}`;
    case "text":
      return typeof value === "string" && value.trim() ? undefined : "is empty";
    case "confirm":
      return typeof value === "boolean" ? undefined : "is not yes or no";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "is not a number";
    case "review": {
      const parsed = ReviewAnswer.safeParse(value);
      if (!parsed.success) return "is not approve, change or reject";
      const { decision, comment } = parsed.data;
      return decision !== "approve" && !comment?.trim()
        ? `needs a comment: ${decision === "change" ? "what to change" : "why"}`
        : undefined;
    }
  }
}

/**
 * Whether `answers` fit the questions of a pause, one line for each thing wrong. Answers may leave
 * a question out (it is skipped), except a review, which always needs its answer; an answer to a
 * question that was not asked is refused. Hosts check with this before they store a decision.
 */
export function checkAnswers(
  questions: readonly AskedQuestion[],
  answers: Answers | undefined,
): string | undefined {
  const review = questions.find((q) => q.kind === "review");
  if (answers === undefined) return review ? `${review.id}: no answer` : undefined;
  const problems: string[] = [];
  for (const id of Object.keys(answers)) {
    if (!questions.some((q) => q.id === id)) problems.push(`${id}: no such question`);
  }
  for (const q of questions) {
    if (!(q.id in answers)) {
      if (q.kind === "review") problems.push(`${q.id}: no answer`);
      continue;
    }
    const problem = invalidAnswer(q, answers[q.id] as Answer);
    if (problem) problems.push(`${q.id}: the answer ${problem}`);
  }
  return problems.length > 0 ? problems.join("\n") : undefined;
}

/**
 * Thrown by a tool's `run` to stop the run and ask a person: the run is saved as waiting with these
 * questions, and when the answers come the call runs again with them as `ctx.answered`. A child run
 * that waits stops its parent's call the same way; `from` names the runs the question came from,
 * nearest first.
 */
export class AwaitingAnswers extends Error {
  readonly questions: AskedQuestion[];
  readonly from: string[];
  constructor(questions: AskedQuestion[], from: string[] = []) {
    super(`waiting for a person to answer ${questions.map((q) => q.id).join(", ")}`);
    this.name = "AwaitingAnswers";
    this.questions = questions;
    this.from = from;
  }
}
