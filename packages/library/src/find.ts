import { shapeWords } from "./data-shape.ts";
import { NEUTRAL_PALETTE, type SkeletonPalette, skeletonSvg } from "./skeleton.ts";
import type { Section, SectionLibrary } from "./store.ts";

/** What a person asks the library for: a phrase, a reference picture, or both. */
export interface FindRequest {
  tenantId: string;
  text?: string;
  /** A screenshot or reference picture (PNG, JPEG, GIF or WebP). */
  image?: Buffer;
  /** `own` (the default): the tenant's sections. `shared`: and every shared one, as skeletons. */
  scope?: "own" | "shared";
  kind?: string;
  layout?: string;
  /** Results per page (10 unless asked, 24 at most). */
  limit?: number;
  /** Results to skip: `limit` times the page before. */
  offset?: number;
}

/** A page of results: fewer than `limit` when little is close enough to the question. */
export interface FoundPage {
  items: Found[];
  /** Another page follows. */
  hasMore: boolean;
  /** Where the next page starts, when there is one. */
  nextOffset: number | null;
}

/**
 * One result, for a screen to draw. `skeletonSvg` is there whenever the section has a skeleton, in
 * the tenant's palette. The tenant's own sections also say where their picture is (`picture`) and
 * give their DSL subtree (`tree`); another club's give neither, nor its name or sources.
 */
export interface Found {
  id: string;
  own: boolean;
  /** Another club's section has no name. */
  name: string;
  kind: string;
  layout: string;
  caption: string;
  tags: string[];
  /** The section's structure, in words. */
  summary: string;
  /** What data it shows, in words: the fields and lists, never values. */
  data: string | null;
  score: number;
  /** Seen in a preview that was built. */
  previewed: boolean;
  skeletonSvg: string | null;
  picture: { key: string; width: number; height: number } | null;
  /** The DSL subtree that draws it (a flat tree), for the tenant's own sections. */
  tree: unknown;
}

export const MAX_FIND_LIMIT = 24;
export const DEFAULT_FIND_LIMIT = 10;

export function toFound(
  s: Section & { score: number },
  palette: SkeletonPalette = NEUTRAL_PALETTE,
): Found {
  return {
    id: s.id,
    own: s.own,
    name: s.name,
    kind: s.kind,
    layout: s.layout,
    caption: s.caption,
    tags: s.tags,
    summary: s.summary,
    data: s.dataShape ? shapeWords(s.dataShape) : null,
    score: s.score,
    previewed: s.previewedAt !== null,
    skeletonSvg: s.skeleton ? skeletonSvg(s.skeleton, palette) : null,
    picture:
      s.own && s.cropKey ? { key: s.cropKey, width: s.cropWidth, height: s.cropHeight } : null,
    tree: s.own ? (s.tree ?? null) : null,
  };
}

/**
 * Searches the section library by words, a picture or both and returns results a screen can draw.
 * Only sections close enough to the question are results, so a page may hold fewer than `limit`,
 * or none. The tenant is the verified one the host passes.
 */
export async function searchLibrary(
  library: Pick<SectionLibrary, "search">,
  req: FindRequest,
  palette: SkeletonPalette = NEUTRAL_PALETTE,
): Promise<FoundPage> {
  const text = req.text?.trim();
  if (!text && !req.image) throw new Error("ask with a phrase, a picture, or both");
  const limit = Math.min(Math.max(req.limit ?? DEFAULT_FIND_LIMIT, 1), MAX_FIND_LIMIT);
  const offset = Math.max(Math.trunc(req.offset ?? 0), 0);
  // one more than a page, to know whether another follows
  const rows = await library.search(req.tenantId, {
    ...(text ? { text } : {}),
    ...(req.image ? { image: req.image } : {}),
    ...(req.kind ? { kind: req.kind } : {}),
    ...(req.layout ? { layout: req.layout } : {}),
    limit: limit + 1,
    offset,
    scope: req.scope ?? "own",
  });
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((r) => toFound(r, palette)),
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}
