import { createHash } from "node:crypto";
import {
  type AskedQuestion,
  AUTO_APPROVED,
  type BuildRecord,
  type BuildReport,
  type ModelClient,
  type ReviewAnswer,
  type RunEvent,
  type Situation,
} from "@dugout/contracts";
import { createRedactor } from "@dugout/core";
import { answerText } from "./decisions.ts";
import { proposePatterns } from "./patterns.ts";
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
  /** The reviewer's words. */
  reason: string;
  /** What the call said it was for: the wording of the approval. */
  why?: string | undefined;
  /** The section the run was working on, in words (ADR 0034). */
  section?: { name?: string | undefined } | undefined;
  /** The agent's own model: the one that knows what the section is. */
  model?: string | undefined;
}

/** The lesson writer answers this when it cannot say it without reversing the reviewer. */
export const UNSURE = "UNSURE";

/**
 * An agent's account of what a run built (ADR 0034), read from the run's own events and output by
 * code. Nothing when the run built nothing worth keeping.
 */
export type BuildReporter = (run: {
  input: unknown;
  /** The run's result, when it completed. */
  output: unknown;
  events: RunEvent[];
  /** Its child runs' events (ADR 0031). */
  childEvents: RunEvent[];
  section: Situation;
}) => BuildReport | undefined;

/** Turns a reviewer rejection into a one-line lesson for future runs. */
export type LessonWriter = (rejection: Rejection) => Promise<string>;

export interface ConsolidateOptions {
  writer: MemoryWriter & Pick<MemoryReader, "sectionsAnswered" | "fact" | "builds">;
  /** The agent's own model, which writes its lessons (ADR 0034). */
  model?: string;
  /** The agent's `record`: with it, a run on a section leaves a build record and no example. */
  record?: BuildReporter;
  /** The run's child runs' events, for `record`. */
  childEvents?: RunEvent[];
  /** What the run was started on (a child's is its parent's); a tool's `situate` overrides it. */
  situation?: Situation;
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
 * - a run that completed with an approved write leaves its last approved input as an example,
 *   unless the agent has a `record`: then a run on a section leaves a build record (ADR 0034),
 *   whoever approved it and however it ended;
 * - `memory.propose` calls become proposed facts that wait for review;
 * - what a person answered to a declared question (ADR 0033) is a decision on the section it was
 *   about, or, for a question about the club, a proposed fact; a section answer given on
 *   {@link PROMOTE_SECTIONS} sections is proposed as the club's fact too.
 */
export async function consolidateRun(opts: ConsolidateOptions): Promise<{
  episodes: MemoryItem[];
  proposals: MemoryItem[];
  decisions: MemoryItem[];
  build: MemoryItem | undefined;
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
  let input: unknown;
  let ending: string | undefined;
  let section = opts.situation;
  const corrected: NonNullable<BuildRecord["corrected"]> = [];
  for (const event of events) {
    if (event.type === "run.started") input = event.data.input;
    if (event.type === "run.completed") ending = event.data.status;
    if (event.type === "run.failed") ending = `failed (${event.data.reason})`;
    if (event.type === "tool.completed" && event.data.situation) section = event.data.situation;
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
      corrected.push({ at: event.at, by: event.data.by, what: redact(reason), runId });
      const rejection: Rejection = {
        tool: event.data.tool,
        input: requested.get(event.data.callId),
        reason,
        ...(asked.get(event.data.callId)?.[0]?.question
          ? { why: asked.get(event.data.callId)?.[0]?.question }
          : {}),
        ...(section?.name ? { section: { name: section.name } } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      };
      // a writer that fails or is not sure leaves the reviewer's own words, as they are
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
        // about the section the run worked on, found by it (ADR 0034)
        ...(section
          ? {
              section: {
                signature: section.section,
                ...(section.name ? { name: redact(section.name) } : {}),
              },
            }
          : {}),
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
  if (ending === "completed" && approved && !opts.record) {
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

  const build =
    opts.record && section
      ? await recordBuild(opts, { input, section, corrected, redact: redactor.value })
      : undefined;
  // what the records of several sections agree on is proposed as a fact (ADR 0034, section 8)
  if (build) proposals.push(...(await proposePatterns({ writer, tenantId, agentId, runId })));
  // no run record (ADR 0034): it held the input, an id, and nothing about the work
  return { episodes, proposals, decisions, build };
}

/**
 * The build record of a run on a section (ADR 0034): what the agent's `record` says it did, and
 * the outcome read from the events. A run the agent has nothing to say about leaves none.
 */
async function recordBuild(
  opts: ConsolidateOptions,
  run: {
    input: unknown;
    section: Situation;
    corrected: NonNullable<BuildRecord["corrected"]>;
    redact: <T>(value: T) => T;
  },
): Promise<MemoryItem | undefined> {
  const { events, agentId, runId } = opts;
  const childEvents = opts.childEvents ?? [];
  const last = events.findLast((e) => e.type === "run.completed" || e.type === "run.failed");
  if (!last || (last.type !== "run.completed" && last.type !== "run.failed")) return undefined;
  const ended =
    last.type === "run.failed" ? "failed" : (last.data.status as "completed" | "rejected");
  const report = opts.record?.({
    input: run.input,
    output: last.type === "run.completed" && ended === "completed" ? last.data.output : undefined,
    events,
    childEvents,
    section: run.section,
  });
  if (!report) return undefined;
  const started = events.find((e) => e.type === "run.started");
  let asked = 0;
  let approvedBy: BuildRecord["outcome"]["approvedBy"] = "none";
  for (const event of events) {
    if (event.type === "question.asked" && !event.data.subject)
      asked += event.data.questions.length;
    if (event.type !== "question.answered") continue;
    const review = event.data.answers.review as ReviewAnswer | undefined;
    if (review?.decision !== "approve") continue;
    if (!event.data.by.endsWith(AUTO_APPROVED)) approvedBy = "person";
    else if (approvedBy === "none") approvedBy = "auto";
  }
  const record: BuildRecord = run.redact({
    v: 1,
    agent: agentId,
    agentVersion: started?.type === "run.started" ? started.data.agentVersion : 0,
    section: {
      signature: run.section.section,
      ...(run.section.name ? { name: run.section.name } : {}),
      ...(report.section?.kind ? { kind: report.section.kind } : {}),
      ...(report.section?.layout ? { layout: report.section.layout } : {}),
      ...(report.section?.labels && Object.keys(report.section.labels).length
        ? { labels: report.section.labels }
        : {}),
    },
    run: {
      runId,
      ...(report.handoffId ? { handoffId: report.handoffId } : {}),
      ...(report.previewUrl ? { previewUrl: report.previewUrl } : {}),
      at: last.at,
    },
    did: report.did,
    ...(report.portable === undefined ? {} : { portable: report.portable }),
    ...(report.patterns?.length ? { patterns: report.patterns } : {}),
    outcome: {
      ended,
      good: ended === "completed" && report.good,
      ...(report.score === undefined ? {} : { score: report.score }),
      remaining: report.remaining ?? [],
      // the run's own turns and its children's: what the build took
      steps: [...events, ...childEvents].filter((e) => e.type === "step.completed").length,
      costUsd: last.data.usage.costUsd,
      asked,
      approvedBy,
    },
    ...(run.corrected.length ? { corrected: run.corrected } : {}),
  });
  const { outcome } = record;
  const how = outcome.good
    ? `good in ${outcome.steps} steps`
    : outcome.ended === "completed"
      ? `not good${outcome.remaining.length ? `: ${outcome.remaining[0]}` : ""}`
      : outcome.ended;
  return opts.writer.recordBuild({
    tenantId: opts.tenantId,
    agentId,
    record,
    content: clip(`${last.at.slice(0, 10)} ${agentId} ${run.redact(report.line)}: ${how}.`, 300),
    ttlDays: EPISODE_TTL_DAYS,
  });
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
  return async ({ tool, input, reason, why, section, model: own }) => {
    const turn = await client.complete({
      // the agent's own model when the run knows it: it knows what the section is
      model: own ?? model,
      tools: [],
      messages: [
        {
          role: "system",
          content: `A reviewer rejected an AI agent's draft, or sent it back asking for a change. Write ONE short imperative sentence the agent should follow next time so the reviewer would not have to ask. Keep the reviewer's meaning: never say the opposite of what they wrote. If you are not sure what they meant, output only ${UNSURE}. Output only the sentence.`,
        },
        {
          role: "user",
          content: [
            section?.name ? `Section: ${section.name}` : undefined,
            `Tool: ${tool}`,
            why ? `The call said: ${why}` : undefined,
            `Draft: ${JSON.stringify(input)}`,
            `Reviewer's reason: ${reason}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    const lesson = turn.message.content.trim().split("\n")[0]?.trim();
    if (!lesson || lesson.toUpperCase().startsWith(UNSURE)) throw new Error("no confident lesson");
    return lesson;
  };
}

/** What a run corrected, as its agent's `corrects` says (ADR 0034). */
export interface Correction {
  /**
   * The id of what the run corrected, as it appears in the link a build record gave for what it
   * made (`run.previewUrl`) or for an earlier correction (`run.edited`): one path segment of it.
   * The agent knows its links; memory only finds the records that name the id.
   */
  of: string;
  /** The link to what the correction made, kept on those records so a later one finds them too. */
  edited?: string;
  /** What people asked, in their words. */
  comments: string[];
}

/**
 * What a person's comments changed in something a run built (ADR 0034), read by code from a run's
 * input, output and events. Nothing when the run changed nothing.
 */
export type CorrectionReporter = (run: {
  input: unknown;
  output: unknown;
  events: RunEvent[];
}) => Correction | undefined;

/**
 * A run that edited what an earlier run built, as people's comments asked, leaves two things on
 * the section it was built for: each comment on the build records that name it (`corrected`, read
 * with the record, ranked below one nobody corrected), and as a lesson about the section. What no
 * record names is left alone.
 */
export async function recordCorrections(opts: {
  writer: MemoryWriter & Pick<MemoryReader, "buildsNaming">;
  tenantId: string;
  agentId: string;
  runId: string;
  at: string;
  by?: string;
  report: Correction;
}): Promise<{ corrected: number; lessons: MemoryItem[] }> {
  const { writer, tenantId, report } = opts;
  const comments = report.comments.map((c) => c.trim()).filter(Boolean);
  if (!report.of || comments.length === 0) return { corrected: 0, lessons: [] };
  const records = await writer.buildsNaming(tenantId, report.of);
  if (records.length === 0) return { corrected: 0, lessons: [] };
  const redactor = createRedactor();
  const redact = (text: string) => redactor.text(text);
  const corrected = comments.map((what) => ({
    at: opts.at,
    by: opts.by ?? "comment",
    what: redact(what),
    runId: opts.runId,
  }));
  for (const record of records)
    await writer.correctBuild(tenantId, record.id, {
      corrected,
      ...(report.edited ? { edited: report.edited } : {}),
    });
  const lessons: MemoryItem[] = [];
  const sections = new Map<string, string | undefined>();
  for (const r of records) {
    const v = r.value as BuildRecord | null;
    if (v?.section.signature) sections.set(v.section.signature, v.section.name);
  }
  for (const [signature, name] of sections) {
    for (const c of corrected) {
      lessons.push(
        await writer.addEpisode({
          tenantId,
          agentId: opts.agentId,
          episodeType: "lesson",
          content: clip(`After this section was built, a person asked: "${c.what}"`, 400),
          section: { signature, ...(name ? { name: redact(name) } : {}) },
          confidence: 0.9,
          sourceRunId: opts.runId,
          ttlDays: EPISODE_TTL_DAYS,
        }),
      );
    }
  }
  return { corrected: records.length, lessons };
}
