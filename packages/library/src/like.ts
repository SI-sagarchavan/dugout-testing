import type { LikeFinder, LikeSection } from "@dugout/memory";
import type { DataShape } from "./data-shape.ts";
import type { Section, SectionLibrary } from "./store.ts";

/**
 * Which of a tenant's sections are like one (ADR 0034, section 5), in code, so a reason can be
 * given: the same kind and layout, then the data they show (the names of their fields), then how
 * their structural summaries read. No embedding, so nothing here depends on one.
 *
 * PURE.
 */

/** The names of every field a shape shows, as the last part of each path. */
export function fieldNames(shape: DataShape | null | undefined): Set<string> {
  const names = new Set<string>();
  if (!shape) return names;
  const last = (path: string) => path.split(".").at(-1)?.replace(/\[\]$/, "") ?? path;
  for (const f of shape.fields) names.add(last(f.path).toLowerCase());
  for (const l of shape.lists) for (const f of l.fields) names.add(last(f.path).toLowerCase());
  return names;
}

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
};

/** Fields in common, over the larger set, needed for two sections to show alike data. */
export const MIN_FIELD_OVERLAP = 0.5;
/** Summary words in common, over all, needed when no data shape can say. */
export const MIN_SUMMARY_OVERLAP = 0.5;

export interface LikeMatch {
  section: Section;
  score: number;
  /** In words, for the model and for a person: why it is like. */
  why: string;
}

/**
 * The candidates that are like `of`, best first. Kind and layout must be the same; then the data
 * they show must overlap by at least {@link MIN_FIELD_OVERLAP}, or, when one of them has no data
 * shape, their summaries by {@link MIN_SUMMARY_OVERLAP}. A section that is neither is not like it:
 * a good record of it is read by no one.
 */
export function rankLike(of: Section, candidates: Section[], limit = 3): LikeMatch[] {
  const mine = fieldNames(of.dataShape);
  const mySummary = tokens(of.summary);
  const out: LikeMatch[] = [];
  for (const c of candidates) {
    if (c.signature === of.signature || c.hidden) continue;
    if (c.kind !== of.kind || c.layout !== of.layout) continue;
    const theirs = fieldNames(c.dataShape);
    const summary = jaccard(mySummary, tokens(c.summary));
    if (mine.size > 0 && theirs.size > 0) {
      let shared = 0;
      for (const f of mine) if (theirs.has(f)) shared++;
      const overlap = shared / Math.max(mine.size, theirs.size);
      if (overlap < MIN_FIELD_OVERLAP) continue;
      out.push({
        section: c,
        score: 2 + overlap + summary / 2,
        why: `same kind and layout (${of.kind}, ${of.layout}), ${shared} of ${Math.max(mine.size, theirs.size)} fields alike`,
      });
    } else if (summary >= MIN_SUMMARY_OVERLAP) {
      out.push({
        section: c,
        score: 1 + summary,
        why: `same kind and layout (${of.kind}, ${of.layout}), structure ${Math.round(summary * 100)}% alike`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The tenant's own sections that are like one, by signature: what `built.like` is found from. */
export function likeFinder(
  library: Pick<SectionLibrary, "findBySignature" | "ofKind">,
): LikeFinder {
  return async (tenantId, signature): Promise<LikeSection[]> => {
    const of = await library.findBySignature(tenantId, signature);
    if (!of || of.hidden) return [];
    const candidates = await library.ofKind(tenantId, of.kind, of.layout);
    return rankLike(of, candidates).map((m) => ({ signature: m.section.signature, why: m.why }));
  };
}
