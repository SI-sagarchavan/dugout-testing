/**
 * Which layers get a screenshot of their own.
 *
 * The export used to screenshot only the root's direct children: the sections.
 * Everything below that was inside someone else's picture, so a masked photo, a
 * crest and an icon were only ever seen baked into a whole section, with the
 * text above them and the cards beside them in the same pixels. Nothing
 * downstream could cut one out cleanly, and the picture it did cut carried
 * whatever else was there.
 *
 * This picks the layers that are ART: the ones nothing downstream can build from
 * the IR, because the IR has no path data and no bitmap bytes. A layer of its
 * own is exactly that layer, nothing else in it.
 *
 *   root    the whole frame, with its own fill, which no section picture holds
 *   mask    a layer that CONTAINS a mask. Its export is the masked result, which
 *           is the only place the mask's effect can be seen (IR 1.9.0 `isMask`)
 *   image   a layer painted with a bitmap and holding no text
 *   vector  the largest subtree made only of paths: a crest, an icon, a swoosh
 *
 * Whatever sits inside a picked mask layer is not picked on its own: the mask's
 * picture already has it, in the shape the design shows.
 *
 * PURE. No Figma.
 */
import { countPaths, hasText, isVectorOnly } from "./ir/artwork.js";
import type { FrameIRNode } from "./ir/schema.js";

export type ArtKind = "root" | "mask" | "image" | "vector";

export interface ArtPick {
  id: string;
  name: string;
  kind: ArtKind;
  /** Layout box, px. */
  w: number;
  h: number;
}

/** The most art screenshots one export carries, masks and photos first, the root last. */
export const MAX_ART_PLATES = 120;

/** A side shorter than this is a rule or a dot, which compiles as a Divider. */
const MIN_THICK_PX = 3;
/** And one smaller than this on both sides is too small to be worth a picture. */
const MIN_ART_PX = 8;

/**
 * Masks and photos first: a layer with no picture of its own has no pixels anywhere downstream, and
 * frame-match never cuts one out of a section picture (that carries whatever is painted over it).
 * The root is last. It is only what the frame is measured against, and the section pictures stand
 * in for it; first, a whole-frame picture took a third of the budget and the card photos went
 * without.
 */
const PRIORITY: Record<ArtKind, number> = { mask: 0, image: 1, vector: 2, root: 3 };

export interface ArtSelection {
  picks: ArtPick[];
  /** How many layers qualified, before the cap. */
  candidates: number;
}

export function selectArtPlates(
  root: FrameIRNode,
  opts: { max?: number; skip?: ReadonlySet<string> } = {},
): ArtSelection {
  const max = opts.max ?? MAX_ART_PLATES;
  const skip = opts.skip ?? new Set<string>();
  const found: ArtPick[] = [];

  const pick = (n: FrameIRNode, kind: ArtKind) =>
    found.push({
      id: n.id,
      name: n.name,
      kind,
      w: n.geometry.bbox.w,
      h: n.geometry.bbox.h,
    });

  const big = (n: FrameIRNode) => {
    const { w, h } = n.geometry.bbox;
    return Math.max(w, h) >= MIN_ART_PX && Math.min(w, h) >= MIN_THICK_PX;
  };

  const visit = (n: FrameIRNode, isRoot: boolean) => {
    if (n.opacity === 0 || n.extractionError) return;
    if (isRoot) {
      pick(n, "root");
    } else if ((n.children ?? []).some((c) => c.isMask === true) && big(n)) {
      // everything inside is in this layer's picture, in the shape the design shows
      if (!skip.has(n.id)) pick(n, "mask");
      return;
    } else if (n.image?.hasImageFill && !hasText(n) && big(n)) {
      if (!skip.has(n.id)) pick(n, "image");
      return;
    } else if (isVectorOnly(n) && countPaths(n) >= 1 && big(n)) {
      if (!skip.has(n.id)) pick(n, "vector");
      return;
    }
    for (const child of n.children ?? []) visit(child, false);
  };
  visit(root, true);

  // what the design does with the most room and the most risk of being baked into something else,
  // and the root after all of it
  found.sort(
    (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.w * b.h - a.w * a.h,
  );
  return { picks: found.slice(0, max), candidates: found.length };
}

/**
 * Past this many pixels at 2x a layer is exported at 1x: a page-tall layer is mostly pixels, and one
 * of them used to take more than half of an export's budget on its own.
 */
export const MAX_PIXELS_2X = 8_000_000;

/**
 * The scale a layer's picture is exported at.
 *
 * Photos are 1x. In the product they come from the API, so the picture is a stand-in to cut from and
 * measure against, and 1x is the size the page renders at. Everything else is 2x (a crest, an icon
 * or a mask's result is platform art, and the sharper picture is the better copy), unless that
 * would be mostly pixels.
 */
export function plateScale(kind: ArtKind | "section", w: number, h: number): 1 | 2 {
  if (kind === "image") return 1;
  return w * h * 4 > MAX_PIXELS_2X ? 1 : 2;
}

export interface FittedPicture {
  bytes: Uint8Array;
  scale: number;
}

/**
 * A picture at `scale`, or at 1x when that is more than is left of the budget: a smaller picture is
 * worth more than none. Undefined when not even 1x fits.
 */
export async function exportWithin(
  exportAt: (scale: number) => Promise<Uint8Array>,
  scale: number,
  remaining: number,
): Promise<FittedPicture | undefined> {
  const first = await exportAt(scale);
  if (first.length <= remaining) return { bytes: first, scale };
  if (scale <= 1) return undefined;
  const smaller = await exportAt(1);
  return smaller.length <= remaining ? { bytes: smaller, scale: 1 } : undefined;
}

/** The file name a plate is stored under: kind first, so a listing groups. */
export function artPlateName(pick: ArtPick, sanitized: string): string {
  return `art-${pick.kind}-${sanitized}-${pick.id.replace(/:/g, "-")}.png`;
}

/** Plate names that are art pictures, which a consumer cuts from and does not measure. */
export const ART_PLATE_PREFIX = "art-";
