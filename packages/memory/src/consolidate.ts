import { createHash } from "node:crypto";
import {
  type AskedQuestion,
  AUTO_APPROVED,
  type ModelClient,
  type ReviewAnswer,
  type RunEvent,
} from "@dugout/contracts";
import { createRedactor } from "@dugout/core";
import { answerText } from "./decisions.ts";
import {
  decisionKey,
  type MemoryItem,
  type MemoryReader,
  type MemoryWriter,
  sameValue,
} from "./store.ts";
import { PROPOSE_TOOL } from "./tools.ts";

export const EPISODE_TTL_DAYS = 180;
/** A section question answered the same on this many sections is proposed as the club's fact. */
export const PROMOTE_SECTIONS = 3;

/** An example longer than this isn't stored: it would crowd out the rest of the recalled memory. */
export const MAX_EXAMPLE_CHARS = 4000;
/** A lesson proposed as a fact is clipped to the length `memory.propose` allows. */
const MAX_FACT_CHARS = 500;

export interface Rejection {
  tool: string;
  input: unknown;
  reason: string;
}

/** Turns a reviewer rejection into a one-line lesson for future runs. */
export type LessonWriter = (rejection: Rejection) => Promise<string>;

export interface ConsolidateOptions {
  writer: MemoryWriter & Pick<MemoryReader, "sectionsAnswered" | "fact">;
  tenantId: string;
  agentId: string;
  runId: string;
  events: RunEvent[];
  lessons?: LessonWriter;
  /**
   * False for a child run: the questions it asked went up to the run a person answered, and are
   * learned there, once, under the agent that asked (ADR 0033). Defaults to true.
   */
  learnsAnswers?: boolean;
}

/**
 * The only path from a run into long-term memory (ADR 0013):
 * - each rejection and change request becomes a lesson, or strengthens the same lesson; a lesson
 *   seen a third time is also proposed as a house fact, for a person to review;
 * - a run that completed with an approved write leaves its last approved input as an example;
 * - a run that ended leaves one run record;
 * - `memory.propose` calls become proposed facts that wait for review;
 * - what a person answered to a declared question (ADR 0033) is a decision on the section it was
 *   about, or, for a question about the club, a proposed fact; a section answer given on
 *   {@link PROMOTE_SECTIONS} sections is proposed as the club's fact too.
 */
export async function consolidateRun(opts: ConsolidateOptions): Promise<{
  episodes: MemoryItem[];
  proposals: MemoryItem[];
  run: MemoryItem | undefined;
  decisions: MemoryItem[];
}> {
  const { writer, tenantId, agentId, runId, events } = opts;
  const episodes: MemoryItem[] = [];
  const proposals: MemoryItem[] = [];

  // everything stored is redacted here, once, whatever the run saw
  const redactor = createRedactor();
  const redact = (text: string) => redactor.text(text);
  const requested = new Map<string, unknown>();
  // the questions each pause asked, to learn from the answers people gave them (ADR 0033)
  const asked = new Map<string, AskedQuestion[]>();
  const decisions: MemoryItem[] = [];
  let approved: { tool: string; input: unknown } | undefined;
  const proposed = new Map<string, unknown>();
  const feedback: string[] = [];
  let input: unknown;
  let ending: string | undefined;
  for (const event of events) {
    if (event.type === "run.started") input = event.data.input;
    if (event.type === "run.completed") ending = event.data.status;
    if (event.type === "run.failed") ending = `failed (${event.data.reason})`;
    if (event.type === "question.asked") asked.set(event.data.callId, event.data.questions);
    // what a person chose is learned; what a host, the agent or memory answered is not, or the
    // agent's own proposals would come back as if people had said them
    if (
      event.type === "question.answered" &&
      event.data.source === "person" &&
      opts.learnsAnswers !== false
    ) {
      for (const q of asked.get(event.data.callId) ?? []) {
        const answer = event.data.answers[q.id];
        if (q.kind === "review" || answer === undefined || !q.about) continue;
        const learned = await learnAnswer(writer, {
          tenantId,
          runId,
          by: event.data.by,
          question: { ...q, question: redact(q.question) },
          answer: typeof answer === "string" ? redact(answer) : answer,
        });
        if (learned.decision) decisions.push(learned.decision);
        if (learned.proposal) proposals.push(learned.proposal);
      }
    }
    // a write waiting for a yes is a pause with a call under review (ADR 0029)
    if (event.type === "question.asked" && event.data.subject) {
      requested.set(event.data.callId, event.data.subject.input);
    }
    const review =
      event.type === "question.answered"
        ? (event.data.answers.review as ReviewAnswer | undefined)
        : undefined;
    // A decision a host made without asking anyone is not an editor's approval, and the example
    // it would leave is shown to later runs as "past work an editor approved".
    if (
      event.type === "question.answered" &&
      review?.decision === "approve" &&
      !event.data.by.endsWith(AUTO_APPROVED) &&
      requested.has(event.data.callId)
    ) {
      approved = { tool: event.data.tool, input: requested.get(event.data.callId) };
    }
    if (event.type === "tool.started" && event.data.tool === PROPOSE_TOOL) {
      proposed.set(event.data.callId, event.data.input);
    }
    // a change request is feedback on the draft just like a rejection, so it is remembered the
    // same way; the run itself went on
    if (
      event.type === "question.answered" &&
      (review?.decision === "reject" || review?.decision === "change")
    ) {
      const rejected = review.decision === "reject";
      const reason = review.comment ?? "";
      feedback.push(`${rejected ? "rejected" : "asked for a change"}: "${reason}"`);
      const rejection = { tool: event.data.tool, input: requested.get(event.data.callId), reason };
      const lesson = await opts.lessons?.(rejection).catch(() => undefined);
      const content = lesson
        ? `${lesson} (Reviewer: "${reason}")`
        : rejected
          ? `A reviewer rejected a ${rejection.tool} draft: "${reason}"`
          : `A reviewer asked for a change to a ${rejection.tool} draft: "${reason}"`;
      const stored = await writer.addEpisode({
        tenantId,
        agentId,
        episodeType: "lesson",
        content: redact(content),
        // Same string a later run uses as its recall query, so this lesson can be found then.
        situation: redact(JSON.stringify(input ?? null)),
        confidence: lesson ? 0.9 : 0.7,
        sourceRunId: runId,
        ttlDays: EPISODE_TTL_DAYS,
      });
      episodes.push(stored);
      if (stored.reinforced && stored.strength === 3) {
        const proposal = await proposeLesson(writer, tenantId, agentId, runId, stored);
        if (proposal) proposals.push(proposal);
      }
    }
    if (event.type === "tool.completed" && event.data.ok && proposed.has(event.data.callId)) {
      const { key, content, confidence } = proposed.get(event.data.callId) as {
        key: string;
        content: string;
        confidence: number;
      };
      proposals.push(
        await writer.proposeFact({
          tenantId,
          agentId,
          key,
          content,
          confidence,
          sourceRunId: runId,
        }),
      );
    }
  }

  // an editor approved this call and the run went on to complete: past work to imitate in style
  if (ending === "completed" && approved) {
    const content = redact(`${approved.tool}: ${JSON.stringify(approved.input ?? null)}`);
    if (content.length <= MAX_EXAMPLE_CHARS) {
      episodes.push(
        await writer.addEpisode({
          tenantId,
          agentId,
          episodeType: "example",
          content,
          situation: redact(JSON.stringify(input ?? null)),
          confidence: 1,
          sourceRunId: runId,
          ttlDays: EPISODE_TTL_DAYS,
        }),
      );
    }
  }

  // what was asked and how it ended, in the reviewer's words; built from the events, no model call
  const run = ending
    ? await writer.addEpisode({
        tenantId,
        agentId,
        episodeType: "run",
        content: redact(
          [
            `Input ${clip(JSON.stringify(input ?? null), 300)}: ${ending}.`,
            ...feedback.map((f) => `Reviewer ${f}.`),
          ].join(" "),
        ),
        confidence: 1,
        sourceRunId: runId,
        ttlDays: EPISODE_TTL_DAYS,
      })
    : undefined;
  return { episodes, proposals, run, decisions };
}

/**
 * One answer a person gave to a declared question (ADR 0033). About a section: a decision on it,
 * and the club's fact once {@link PROMOTE_SECTIONS} sections were given the same answer. About the
 * club: its fact, proposed for a person to approve. A fact that already says it is not proposed
 * again.
 */
async function learnAnswer(
  writer: ConsolidateOptions["writer"],
  a: { tenantId: string; runId: string; by: string; question: AskedQuestion; answer: unknown },
): Promise<{ decision?: MemoryItem; proposal?: MemoryItem }> {
  const { tenantId, runId, question: q, answer } = a;
  const about = q.about;
  if (!about) return {};
  const said = answerText(answer);
  const out: { decision?: MemoryItem; proposal?: MemoryItem } = {};
  let sources: string[] = [];
  if (about.scope === "section") {
    // a section question asked before the run knew its section says nothing about one
    if (!about.section) return {};
    const on = about.name ? `"${about.name}"` : `section ${about.section.slice(0, 12)}`;
    out.decision = await writer.recordDecision({
      tenantId,
      agentId: about.agent,
      key: decisionKey(about.agent, q.id, about.section),
      value: answer,
      content: `On ${on}, ${a.by} answered "${q.question}": ${said}.`,
      sourceRunId: runId,
      ttlDays: EPISODE_TTL_DAYS,
    });
    if (!about.fact) return out;
    const same = await writer.sectionsAnswered(tenantId, about.agent, q.id, answer);
    if (same.length < PROMOTE_SECTIONS) return out;
    sources = same.map((d) => d.id);
  }
  if (!about.fact) return out;
  for (const status of ["active", "proposed"] as const) {
    const fact = await writer.fact(tenantId, about.fact, status);
    if (fact && sameValue(fact.value, answer)) return out;
  }
  out.proposal = await writer.proposeFact({
    tenantId,
    agentId: about.agent,
    key: about.fact,
    content: clip(
      sources.length
        ? `"${q.question}": ${said} (a person's answer on ${sources.length} sections).`
        : `"${q.question}": ${said}.`,
      MAX_FACT_CHARS - 1,
    ),
    confidence: 1,
    sourceRunId: runId,
    value: answer,
    ...(sources.length ? { sources } : {}),
  });
  return out;
}

/**
 * A lesson that keeps coming back belongs in the house facts. Proposes it once: the key comes from
 * the lesson's text, so a rejected or already-proposed lesson isn't proposed again.
 */
async function proposeLesson(
  writer: MemoryWriter,
  tenantId: string,
  agentId: string,
  runId: string,
  lesson: MemoryItem,
): Promise<MemoryItem | undefined> {
  const key = `lesson.${createHash("sha256").update(lesson.content).digest("hex").slice(0, 8)}`;
  if ((await writer.history(tenantId, key)).length > 0) return undefined;
  return writer.proposeFact({
    tenantId,
    agentId,
    key,
    content: clip(lesson.content, MAX_FACT_CHARS - 1), // clip adds an ellipsis
    confidence: lesson.confidence,
    sourceRunId: runId,
  });
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A `LessonWriter` that asks a model for one imperative sentence. */
export function createModelLessonWriter(client: ModelClient, model: string): LessonWriter {
  return async ({ tool, input, reason }) => {
    const turn = await client.complete({
      model,
      tools: [],
      messages: [
        {
          role: "system",
          content:
            "A reviewer rejected an AI agent's draft, or sent it back asking for a change. Write ONE short imperative sentence the agent should follow next time so the reviewer would not have to ask. Output only the sentence.",
        },
        {
          role: "user",
          content: `Tool: ${tool}\nDraft: ${JSON.stringify(input)}\nReviewer's reason: ${reason}`,
        },
      ],
    });
    const lesson = turn.message.content.trim().split("\n")[0]?.trim();
    if (!lesson) throw new Error("empty lesson");
    return lesson;
  };
}
