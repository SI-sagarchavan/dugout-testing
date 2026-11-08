/**
 * A tenant's skeleton palette, learned from its own designs (ticket 14): what colours its sections
 * paint as the page, as cards and as accents, and what colour its text is on each, counted by area
 * over the sections of the Handoffs it previewed, each paint resolved through the theme that
 * preview used. Proposed as a house fact (`library.palette`) that a person approves; another
 * club's skeletons are drawn in it from then on.
 *
 * PURE.
 */

import type { IrNode, Paint } from "./ir.ts";
import { NEUTRAL_PALETTE, roleOf, type SkeletonPalette } from "./skeleton.ts";

/** The fact key a tenant's palette is kept under. */
export const PALETTE_FACT = "library.palette";

type Role = "page" | "surface" | "accent" | "ink" | "onAccent";
/** Area painted in each colour, by role. */
export type PaintVotes = Record<Role, Map<string, number>>;

export const emptyVotes = (): PaintVotes => ({
  page: new Map(),
  surface: new Map(),
  accent: new Map(),
  ink: new Map(),
  onAccent: new Map(),
});

/**
 * A theme artifact's colours as a paint resolver: `{ tokens: { <set>: { color: { light: {
 * background_main_surface: "#ffffff" } } } } }`, a token ref `background/main/surface` read as
 * `background_main_surface`. A paint's own raw colour wins.
 */
export function themeColours(theme: unknown): (paint: Paint) => string | undefined {
  const colours = new Map<string, string>();
  const sets = (theme as { tokens?: Record<string, unknown> } | null)?.tokens ?? {};
  for (const set of Object.values(sets)) {
    const color = (set as { color?: Record<string, unknown> } | null)?.color ?? {};
    // light first: a design is drawn in its light scheme unless it says otherwise
    for (const scheme of ["dark", "light"]) {
      const values = (color[scheme] ?? {}) as Record<string, unknown>;
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === "string" && HEX.test(value)) colours.set(tokenKey(name), value);
      }
    }
  }
  return (paint) => {
    if (paint.raw && HEX.test(paint.raw)) return paint.raw.slice(0, 7).toLowerCase();
    return paint.tokenRef
      ? colours.get(tokenKey(paint.tokenRef))?.slice(0, 7).toLowerCase()
      : undefined;
  };
}

const HEX = /^#[0-9a-f]{6}/i;
const tokenKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/^color[./]/, "")
    .replace(/[^a-z0-9]+/g, "_");

/**
 * Adds one section's paints to `votes`: its own fill is the page; a fill inside it is a card or an
 * accent, by its role; a text's fill is ink, or ink on an accent when the nearest fill under it is
 * one. Weighed by area, so the paint a design is mostly made of counts most.
 */
export function addPaintVotes(
  votes: PaintVotes,
  section: IrNode,
  colourOf: (paint: Paint) => string | undefined,
): void {
  const vote = (role: Role, colour: string | undefined, weight: number) => {
    if (!colour || !(weight > 0)) return;
    votes[role].set(colour, (votes[role].get(colour) ?? 0) + weight);
  };
  const areaOf = (n: IrNode) => Math.max(0, n.geometry.bbox.w) * Math.max(0, n.geometry.bbox.h);

  const covers = (n: IrNode) => (n.type === "IMAGE" || Boolean(n.image)) && !n.children?.length;
  // `onImage`: drawn over a picture, where text and overlays are in the picture's colours, not the
  // design's, so they say nothing of its palette
  const walk = (node: IrNode, under: "page" | "surface" | "accent", onImage: boolean) => {
    const fill = node.fill;
    const colour = fill && !onImage ? colourOf(fill) : undefined;
    if (node.type === "TEXT" || node.text) {
      vote(under === "accent" ? "onAccent" : "ink", colour, areaOf(node));
      return;
    }
    if (covers(node) || node.type === "VECTOR") return;
    let next = under;
    if (fill && colour && !node.image) {
      const role = roleOf({ ...fill, raw: colour });
      if (node === section) {
        vote(role === "accent" ? "accent" : "page", colour, areaOf(node));
        next = role === "accent" ? "accent" : "page";
      } else {
        vote(role, colour, areaOf(node));
        next = role;
      }
    }
    const area = areaOf(node);
    const pictured =
      onImage ||
      Boolean(node.image) ||
      (area > 0 && (node.children ?? []).some((c) => covers(c) && areaOf(c) >= area * 0.5));
    for (const child of node.children ?? []) walk(child, next, pictured);
  };
  walk(section, "page", false);
}

/** The colour most painted in a role that reads on `on`, or undefined when none was. */
const legible = (votes: Map<string, number>, on: string) =>
  [...votes]
    .filter(([c]) => Math.abs(luminance(c) - luminance(on)) >= MIN_CONTRAST)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
/** How far apart in lightness text and what it is on must be to count as legible. */
const MIN_CONTRAST = 0.35;

/** The colour most painted in a role, or undefined when none was. */
const top = (votes: Map<string, number>, not: string[] = []) =>
  [...votes].filter(([c]) => !not.includes(c)).sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * The palette the votes make: the most painted colour in each role, the page falling back to the
 * most painted card colour, and placeholders and lines mixed from the page and the ink, so the
 * skeleton keeps the design's contrast. Undefined when the designs painted nothing it can read.
 */
export function paletteFromVotes(votes: PaintVotes): SkeletonPalette | undefined {
  const page = top(votes.page) ?? top(votes.surface);
  if (!page) return undefined;
  const surface = top(votes.surface, [page]) ?? page;
  const accent = top(votes.accent) ?? NEUTRAL_PALETTE.accent;
  const ink = legible(votes.ink, surface) ?? (luminance(surface) < 0.5 ? "#f5f5f5" : "#212121");
  const onAccent =
    legible(votes.onAccent, accent) ?? (luminance(accent) < 0.5 ? "#ffffff" : "#212121");
  return {
    page,
    surface,
    accent,
    // text is drawn as bars, quieter than real text
    ink: mix(surface, ink, 0.35),
    onAccent: mix(accent, onAccent, 0.6),
    placeholder: mix(surface, ink, 0.12),
    line: mix(surface, ink, 0.25),
  };
}

const LABELS: Array<[keyof SkeletonPalette, string]> = [
  ["page", "page"],
  ["surface", "cards"],
  ["accent", "accent"],
  ["ink", "text"],
  ["onAccent", "text on accent"],
  ["placeholder", "pictures"],
  ["line", "lines"],
];

/** The fact's words: "Other clubs' sections are drawn in: page #f5f5f5, cards #ffffff, …". */
export function paletteFact(p: SkeletonPalette): string {
  return `Other clubs' sections in the section library are drawn in: ${LABELS.map(([k, label]) => `${label} ${p[k]}`).join(", ")}.`;
}

/** The palette a fact's words name; colours it leaves out are the neutral ones. */
export function parsePaletteFact(content: string): SkeletonPalette | undefined {
  const out: SkeletonPalette = { ...NEUTRAL_PALETTE };
  let found = 0;
  // longest labels first, so "text on accent" is not read as "text"
  for (const [key, label] of [...LABELS].sort((a, b) => b[1].length - a[1].length)) {
    const m = new RegExp(`(?:^|[\\s:,])${label} (#[0-9a-f]{6})`, "i").exec(content);
    if (m?.[1]) {
      out[key] = m[1].toLowerCase();
      found++;
    }
  }
  return found ? out : undefined;
}

function rgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** `a` moved `t` of the way to `b`. */
function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x
    .map((v, i) =>
      Math.round(v + ((y[i] ?? v) - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
