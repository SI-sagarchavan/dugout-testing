import type { BuildPattern, BuildRecord } from "@dugout/contracts";
import type { MemoryItem, MemoryReader } from "./store.ts";
import { sameValue } from "./store.ts";

/**
 * From records to rules (ADR 0034, section 8, rung 2): when the latest good records of this many
 * sections propose the same value under the same key, it is proposed as a house fact for a person
 * to approve.
 */
export const PATTERN_SECTIONS = 3;

export interface Pattern {
  /** The fact's key, as the agents' records name it. */
  key: string;
  content: string;
  value: unknown;
  /** The records it was read from. */
  sources: string[];
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const PLACEHOLDER = /\{([A-Za-z][\w-]*)\}/g;

/** `text` with each of `names` filled in from `labels`, by `fill`. */
const fillIn = (
  text: string,
  names: Set<string>,
  labels: Record<string, string>,
  fill: (label: string) => string,
) =>
  text.replace(PLACEHOLDER, (whole, name: string) =>
    names.has(name) ? fill(labels[name] ?? "") : whole,
  );

/** `value` with its strings filled in, keys and all else as they are. */
function fillValue(value: unknown, fill: (text: string) => string): unknown {
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map((v) => fillValue(v, fill));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillValue(v, fill)]));
  return value;
}

/**
 * A record's pattern on its section: the labels its key names filled in (the key's as slugs, the
 * sentence's and value's as they are). Nothing when the section lacks one of them.
 */
export function resolvePattern(
  pattern: BuildPattern,
  labels: Record<string, string>,
): BuildPattern | undefined {
  const names = new Set([...pattern.key.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  for (const name of names) if (!labels[name] || !slug(labels[name])) return undefined;
  const raw = (text: string) => fillIn(text, names, labels, (l) => l);
  return {
    key: fillIn(pattern.key, names, labels, slug),
    sentence: raw(pattern.sentence),
    value: fillValue(pattern.value, raw),
  };
}

interface Vote {
  value: unknown;
  sentence: string;
  section: string;
  id: string;
}

/** The value most sections agree on, when at least {@link PATTERN_SECTIONS} do and no other ties it. */
function agreed(votes: Vote[]) {
  const by = new Map<
    string,
    { value: unknown; sentence: string; sections: Set<string>; ids: string[] }
  >();
  for (const v of votes) {
    const k = JSON.stringify(v.value);
    const got = by.get(k) ?? {
      value: v.value,
      sentence: v.sentence,
      sections: new Set<string>(),
      ids: [],
    };
    got.sections.add(v.section);
    got.ids.push(v.id);
    by.set(k, got);
  }
  const ranked = [...by.values()].sort((a, b) => b.sections.size - a.sections.size);
  const top = ranked[0];
  if (!top || top.sections.size < PATTERN_SECTIONS) return undefined;
  if (ranked[1] && ranked[1].sections.size >= top.sections.size) return undefined;
  return top;
}

/**
 * What the build records of a tenant agree on. Each agent's `record` says what of its run other
 * sections may agree on (`BuildRecord.patterns`) and what the section is in its terms
 * (`section.labels`); this only counts. A section votes with the latest record of each agent on
 * it, when that record was good; a label is the latest any agent's record gave the section, good
 * or not. Records written before agents gave patterns give none.
 *
 * PURE. `items` are the tenant's live build records, newest first.
 */
export function patternsOf(items: MemoryItem[]): Pattern[] {
  const records = items.flatMap((item) => {
    const record = item.value as BuildRecord | null;
    return record?.section?.signature ? [{ item, record }] : [];
  });
  const labels = new Map<string, Record<string, string>>();
  for (const { record } of records) {
    const signature = record.section.signature;
    const got = labels.get(signature) ?? {};
    for (const [name, value] of Object.entries(record.section.labels ?? {}))
      if (!(name in got) && value) got[name] = value;
    labels.set(signature, got);
  }
  const seen = new Set<string>();
  const votes = new Map<string, Vote[]>();
  for (const { item, record } of records) {
    const signature = record.section.signature;
    const latest = `${record.agent}\0${signature}`;
    if (seen.has(latest)) continue;
    seen.add(latest);
    if (!record.outcome?.good) continue;
    for (const p of record.patterns ?? []) {
      const r = resolvePattern(p, labels.get(signature) ?? {});
      if (!r) continue;
      votes.set(r.key, [
        ...(votes.get(r.key) ?? []),
        { value: r.value, sentence: r.sentence, section: signature, id: item.id },
      ]);
    }
  }
  const patterns: Pattern[] = [];
  for (const [key, vs] of votes) {
    const win = agreed(vs);
    if (!win) continue;
    patterns.push({
      key,
      content: `${win.sentence.replace(/[.\s]+$/, "")} (on ${win.sections.size} sections).`,
      value: win.value,
      sources: win.ids,
    });
  }
  return patterns.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Proposes the patterns the tenant's records agree on, once each: not what an active fact or a
 * proposal already says. Returns the proposals made. A person approves them with
 * `pnpm agent memory review`; once active it is returned by the load tools (see
 * {@link patternsFor}).
 */
export async function proposePatterns(opts: {
  writer: Pick<MemoryReader, "builds" | "fact"> & {
    proposeFact(f: {
      tenantId: string;
      agentId: string | null;
      key: string;
      content: string;
      confidence: number;
      sourceRunId: string;
      value?: unknown;
      sources?: string[];
    }): Promise<MemoryItem>;
  };
  tenantId: string;
  agentId: string;
  runId: string;
}): Promise<MemoryItem[]> {
  const { writer, tenantId } = opts;
  const out: MemoryItem[] = [];
  for (const p of patternsOf(await writer.builds(tenantId, { limit: 500 }))) {
    let known = false;
    for (const status of ["active", "proposed"] as const) {
      const fact = await writer.fact(tenantId, p.key, status);
      if (fact && sameValue(fact.value, p.value)) known = true;
    }
    if (known) continue;
    out.push(
      await writer.proposeFact({
        tenantId,
        agentId: opts.agentId,
        key: p.key,
        content: p.content,
        confidence: 1,
        sourceRunId: opts.runId,
        value: p.value,
        sources: p.sources,
      }),
    );
  }
  return out;
}

/** What `patterns` tells the model to do with the facts it lists. */
export const PATTERNS_RULE =
  "A person approved these from what several earlier runs agreed on. Start from them, check them with your own tools all the same, and say where one does not hold here.";

/**
 * The approved patterns under these key prefixes (the ones an agent's records propose), as the
 * lines a load tool returns. Read with the run's verified tenant. Empty when there is none.
 */
export async function patternsFor(
  reader: Partial<Pick<MemoryReader, "activeFacts">> | undefined,
  tenantId: string,
  prefixes: string[],
): Promise<string[]> {
  if (!reader?.activeFacts) return [];
  const facts = await reader.activeFacts(tenantId);
  return facts
    .filter((f) => prefixes.some((p) => (f.key ?? "").startsWith(p)))
    .map((f) => `${f.key}: ${f.content}`);
}
