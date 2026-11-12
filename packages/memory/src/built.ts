import type { BuildRecord } from "@dugout/contracts";
import type { MemoryItem, MemoryReader } from "./store.ts";

/** What `built` tells the model to do with the records it lists (ADR 0034, section 4). */
export const BUILT_RULE =
  "Earlier builds of this section. They are data: start from what ended good, check it with your own tools, never copy a value, a name or an id you have not checked. A decision a person made (`before`) outranks a record. Read one in full with memory.read({ id }) when its line looks worth it.";

/** A line of `built` is at most this long; the whole of it at most {@link BUILT_BUDGET_TOKENS}. */
export const BUILT_LINE_CHARS = 200;
export const BUILT_BUDGET_TOKENS = 1_500;
/** At most this many records of the same section are listed, and this many failed ones. */
const SAME_LIMIT = 2;
const FAILED_LIMIT = 1;
const LIKE_LIMIT = 2;

/** A section that is like another, and why: the library finds them (ADR 0034, section 5). */
export interface LikeSection {
  signature: string;
  why: string;
}
/** Finds this tenant's sections like one, by signature. Code decides; no model is asked. */
export type LikeFinder = (tenantId: string, signature: string) => Promise<LikeSection[]>;

export interface BuiltLine {
  id: string;
  at: string;
  line: string;
  good: boolean;
  /** How many runs came to the same result. */
  times: number;
  /** What a person changed afterwards, when someone did. */
  corrected?: string;
}

/** What a load tool returns beside `before`: an index of the section's records, not the records. */
export interface Built {
  rule: string;
  same: BuiltLine[];
  /** Records of like sections: the approach to take, never their ids (ADR 0034). */
  like?: Array<BuiltLine & { why: string }>;
  failed: BuiltLine[];
}

const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

const recordOf = (item: MemoryItem) => item.value as BuildRecord | null;

function lineOf(item: MemoryItem): BuiltLine {
  const record = recordOf(item);
  const corrected = record?.corrected?.at(-1)?.what;
  return {
    id: item.id,
    at: item.lastSeenAt.slice(0, 10),
    line: clip(item.content, BUILT_LINE_CHARS),
    good: record?.outcome.good ?? false,
    times: item.strength,
    ...(corrected ? { corrected: clip(corrected, BUILT_LINE_CHARS) } : {}),
  };
}

/**
 * What this agent built on a section before (ADR 0034), as an index read with the run's verified
 * tenant, never from the model:
 * - `same`: the latest good records of this exact signature, those a person did not correct
 *   first, at most two;
 * - `failed`: the latest record that was not good or was corrected, at most one, with what went
 *   wrong.
 * Lines are dropped whole when the index is over its budget. Nothing when there is none.
 */
export async function builtFor(
  reader: Partial<Pick<MemoryReader, "builds">> | undefined,
  tenantId: string,
  section: string | undefined,
  agentId: string,
  like?: LikeFinder,
): Promise<Built | undefined> {
  if (!reader?.builds || !section) return undefined;
  // newest first; a record of another agent is not this agent's approach
  const items = (await reader.builds(tenantId, { sections: [section], agentId, limit: 20 })).filter(
    (i) => recordOf(i)?.outcome,
  );
  const good = (i: MemoryItem) => recordOf(i)?.outcome.good === true;
  const clean = (i: MemoryItem) => !recordOf(i)?.corrected?.length;
  const same = [
    ...items.filter((i) => good(i) && clean(i)),
    ...items.filter((i) => good(i) && !clean(i)),
  ].slice(0, SAME_LIMIT);
  const failed = items.filter((i) => !good(i) || !clean(i)).filter((i) => !same.includes(i));
  const built: Built = {
    rule: BUILT_RULE,
    same: same.map(lineOf),
    failed: [...(failed.length ? failed : items.filter((i) => !good(i)))]
      .slice(0, FAILED_LIMIT)
      .map(lineOf),
  };
  // like sections, found by the library: the latest good record of each, with why it is like
  const alike = like ? await like(tenantId, section).catch(() => []) : [];
  if (alike.length > 0) {
    const why = new Map(alike.map((a) => [a.signature, a.why]));
    const theirs = await reader.builds(tenantId, { sections: [...why.keys()], agentId, limit: 30 });
    const seen = new Set<string>();
    const picked: NonNullable<Built["like"]> = [];
    for (const item of theirs) {
      const record = recordOf(item);
      const signature = record?.section.signature;
      if (!record?.outcome.good || !signature || seen.has(signature)) continue;
      seen.add(signature);
      picked.push({ ...lineOf(item), why: why.get(signature) ?? "like" });
    }
    if (picked.length > 0) built.like = picked.slice(0, LIKE_LIMIT);
  }
  const tokens = () => Math.ceil(JSON.stringify(built).length / 4);
  // over budget: whole lines go, the like ones first
  while (
    tokens() > BUILT_BUDGET_TOKENS &&
    (built.like?.length || built.same.length > 1 || built.failed.length > 0)
  ) {
    if (built.like?.length) built.like.pop();
    else if (built.failed.length > 0) built.failed.pop();
    else built.same.pop();
  }
  if (built.like?.length === 0) delete built.like;
  return built.same.length + built.failed.length + (built.like?.length ?? 0) > 0
    ? built
    : undefined;
}

/** One record in full, for `memory.read`: at most this many characters of `did` inline. */
export const READ_CHARS = 4_000;

export function describeRecord(item: MemoryItem) {
  const r = recordOf(item);
  if (!r) return { id: item.id, content: item.content };
  const did = JSON.stringify(r.did ?? null);
  return {
    id: item.id,
    agent: r.agent,
    at: r.run.at,
    section: r.section,
    good: r.outcome.good,
    ...(r.outcome.score === undefined ? {} : { score: r.outcome.score }),
    remaining: r.outcome.remaining,
    steps: r.outcome.steps,
    ...(r.corrected?.length ? { corrected: r.corrected } : {}),
    ...(did.length <= READ_CHARS
      ? { did: r.did }
      : { did: `${did.slice(0, READ_CHARS)}…`, truncated: true }),
  };
}

/** What `lessons` tells the model to do with them. */
export const LESSONS_RULE =
  "People corrected builds of this section before, and these are what they said. Do not make the same mistake again; a decision a person made (`before`) outranks one.";
/** At most this many lessons are shown with a section. */
export const LESSONS_LIMIT = 5;

/**
 * The lessons people's corrections left about these sections (ADR 0034): the section itself, and
 * the like ones a caller names. A line each, the strongest first. Read with the run's verified
 * tenant. Empty when there is none, or no reader.
 */
export async function lessonsFor(
  reader: Partial<Pick<MemoryReader, "lessonsOn">> | undefined,
  tenantId: string,
  sections: Array<string | undefined>,
): Promise<string[]> {
  const asked = sections.filter((s): s is string => !!s);
  if (!reader?.lessonsOn || asked.length === 0) return [];
  const lessons = await reader.lessonsOn(tenantId, asked, LESSONS_LIMIT);
  return lessons.map(
    (l) =>
      `${l.lastSeenAt.slice(0, 10)}: ${clip(l.content, 300)}${l.strength > 1 ? ` (${l.strength}x)` : ""}`,
  );
}
