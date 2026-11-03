/**
 * Layout detection: what each container of a frame IS — a list, a row, a grid, a carousel, tabs.
 *
 * The compiler draws what the frame shows, and a static frame of a carousel is a clipped row. This
 * reads the same Figma IR for what gives the behaviour away, and proposes an intent per
 * container (`LayoutIntent`, `@fanos/dsl`), with the evidence it used and how sure it is:
 *
 * - **a collection**: two or more siblings that are one component (instances of one name, whose
 *   variants differ) or one shape (`canonicalSignature`). Art (logos, crests, glyphs) and rules
 *   between items are not items.
 * - **its arrangement**, from geometry: one row, one column, or a grid aligned on both axes.
 * - **carousel evidence**, each enough on its own: an item cut off by the clip edge; a designed
 *   previous/next arrow; a row of dots with one drawn active. Dots also say how many pages.
 * - **tabs evidence**: a row of label items where exactly one is drawn differently.
 *
 * What a frame cannot show goes in `ask`, as plain questions, with the defaults the proposal
 * already uses. Nothing here guesses past the frame: a row that merely fits is `unsure`, and the
 * question goes to a person.
 *
 * One DSL per device: values are plain, for the frame's own width.
 */

import type {
  CarouselConfig,
  Confidence,
  LayoutChoice,
  LayoutChrome,
  LayoutIntent,
  LayoutKind,
} from "@fanos/dsl";
import { isVectorOnly, type FrameIRDocument, type FrameIRNode } from "@fanos/surface-canvas/ir";
import { isIconGroup, isRule } from "../classify.js";

/** Pixels two edges may differ by and still be one line. */
const TOL = 2;
/** A collection without carousel evidence needs this many items; with it, two. */
const MIN_ITEMS = 3;
/** Smaller than this, an item is a glyph or a stat, not a card. */
const MIN_ITEM_AREA = 40 * 40;
/** A card a person would page through, rather than a chip or a logo. */
const CARD = { w: 120, h: 80 };
/** A control a person presses: an arrow button, not a panel. */
const MAX_CONTROL_PX = 64;
/** A pagination dot, or the wider pill an active dot is often drawn as. */
const MAX_DOT_PX = { w: 40, h: 24 };
/** Levels above a carousel to look for its designed controls. */
const CONTROL_SEARCH_DEPTH = 3;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const box = (n: FrameIRNode): Box => n.geometry.bbox;
const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
const round1 = (v: number) => Math.round(v * 10) / 10;

export interface DetectOptions {
  /** Report only containers whose kind is one of these. Default: all. */
  kinds?: LayoutKind[];
}

export function detectLayout(doc: FrameIRDocument, options: DetectOptions = {}): LayoutIntent[] {
  const parents = new Map<string, FrameIRNode | null>();
  const index = (n: FrameIRNode, parent: FrameIRNode | null) => {
    parents.set(n.id, parent);
    for (const child of n.children ?? []) index(child, n);
  };
  index(doc.root, null);

  const intents: LayoutIntent[] = [];
  const visit = (n: FrameIRNode) => {
    const found = detectContainer(doc.root, n, parents);
    if (found) intents.push(found);
    // Items are one template repeated: what is inside the first is inside them all, so it is
    // looked at once. A list of packages each holding a row of cards reports that row once.
    const items = new Set((found?.items ?? []).slice(1));
    for (const child of n.children ?? []) if (!items.has(child.id)) visit(child);
  };
  visit(doc.root);
  return options.kinds ? intents.filter((i) => options.kinds!.includes(i.kind)) : intents;
}

// ---------------------------------------------------------------------------
// One container
// ---------------------------------------------------------------------------

function detectContainer(
  root: FrameIRNode,
  container: FrameIRNode,
  parents: Map<string, FrameIRNode | null>,
): LayoutIntent | undefined {
  if (isArt(container)) return undefined;
  const items = collectionOf(container);
  if (!items) return undefined;
  const arranged = arrangement(items.map(box));
  if (!arranged) return undefined;

  const clip = clipBoxOf(root, container, parents);
  const first = box(items[0]!);
  const evidence: string[] = [];
  const base = { src: container.id, name: container.name, items: items.map((i) => i.id) };

  if (arranged.kind === "grid") {
    if (items.length < MIN_ITEMS) return undefined;
    evidence.push(`${items.length} matching items on ${arranged.columns} columns and ${arranged.rows} rows`);
    const choice: LayoutChoice = {
      src: container.id,
      kind: "grid",
      config: { columns: arranged.columns, rows: arranged.rows },
    };
    return { ...base, kind: "grid", confidence: "likely", evidence, ask: [], choice, chrome: {} };
  }

  if (arranged.kind === "column") {
    if (items.length < MIN_ITEMS) return undefined;
    const below = cutOff(items, clip, "y");
    evidence.push(`${items.length} matching items in one column`);
    if (below > 0) evidence.push(`${below} cut off by the bottom edge: the list scrolls`);
    return {
      ...base,
      kind: "list",
      confidence: below > 0 ? "certain" : "likely",
      evidence,
      ask: [],
      choice: { src: container.id, kind: "list" },
      chrome: {},
    };
  }

  // --- a row ---------------------------------------------------------------
  // Cut off by the edge says "there is more to scroll to" only for a real run of items: two
  // photos of a collage overhanging a clip are artwork, not a carousel.
  const cut = items.length >= MIN_ITEMS ? cutOff(items, clip, "x") : 0;
  const cutBefore = cut > 0 ? items.filter((i) => box(i).x < clip.x - TOL).length : 0;
  const cutAfter = cut > 0 ? items.filter((i) => right(box(i)) > right(clip) + TOL).length : 0;
  const chrome = controlsNear(container, items, parents);
  const dots = chrome.pagination ? dotsOf(findById(root, chrome.pagination)!) : undefined;
  const carouselEvidence: string[] = [];
  if (cutBefore + cutAfter > 0) {
    carouselEvidence.push(
      cutBefore > 0 && cutAfter > 0
        ? `items cut off by both edges of "${nameOfClip(root, container, parents)}"`
        : `${cutBefore + cutAfter} of ${items.length} items cut off by the edge of "${nameOfClip(root, container, parents)}"`,
    );
  }
  if (chrome.prev || chrome.next) {
    const parts = [chrome.prev && "previous", chrome.next && "next"].filter(Boolean).join(" and ");
    carouselEvidence.push(`a designed ${parts} arrow`);
    if (byPosition(chrome, root)) carouselEvidence.push("the arrows' names point the other way to their order: read by position");
  }
  if (dots) carouselEvidence.push(`${dots.count} pagination dots, page ${dots.active + 1} drawn active`);

  if (carouselEvidence.length > 0) {
    return carousel(base, container, items, clip, chrome, dots, [
      `${items.length} matching items in one row`,
      ...carouselEvidence,
    ]);
  }

  if (items.length < MIN_ITEMS) return undefined;
  evidence.push(`${items.length} matching items in one row`);

  const tabs = tabsOf(container, items);
  if (tabs) {
    evidence.push(
      `each item is one label, and only "${tabs.options[tabs.active]}" is drawn differently: the selected tab`,
    );
    const named = /\btabs?\b/i.test(container.name) || items.every((i) => /\btabs?\b/i.test(i.name));
    if (named) evidence.push("the layers are named as tabs");
    return {
      ...base,
      kind: "tabs",
      confidence: named ? "certain" : "likely",
      evidence,
      ask: [],
      choice: { src: container.id, kind: "tabs", config: tabs },
      chrome: {},
    };
  }

  if (/\b(menu|nav|navigation)\b/i.test(container.name)) {
    evidence.push("named as navigation");
    return { ...base, kind: "row", confidence: "likely", evidence, ask: [], choice: { src: container.id, kind: "row" }, chrome: {} };
  }

  // Cards that fill the row with nothing past the edge: a fixed row, or a carousel that only
  // starts to move when there are more. The frame cannot tell; a person can.
  const cards = first.w >= CARD.w && first.h >= CARD.h;
  if (cards) {
    evidence.push(`all ${items.length} fit inside "${nameOfClip(root, container, parents)}"; no arrows or dots`);
    return {
      ...base,
      kind: "row",
      confidence: "unsure",
      alternative: "carousel",
      evidence,
      ask: [
        `Is "${container.name}" a fixed row of ${items.length}, or a carousel that scrolls when there are more than ${items.length}? (proposed: a fixed row)`,
      ],
      choice: { src: container.id, kind: "row" },
      chrome: {},
    };
  }
  return { ...base, kind: "row", confidence: "likely", evidence, ask: [], choice: { src: container.id, kind: "row" }, chrome: {} };
}

function carousel(
  base: { src: string; name: string; items: string[] },
  container: FrameIRNode,
  items: FrameIRNode[],
  clip: Box,
  chrome: LayoutChrome,
  dots: { count: number; active: number } | undefined,
  evidence: string[],
): LayoutIntent {
  const first = box(items[0]!);
  const gap = items.length > 1 ? box(items[1]!).x - right(first) : 0;
  // Slides keep their designed width, so the design's first paint is exactly what Swiper lays
  // out. Only items sized to share the row (`fill`) divide the width by a count.
  const fills = items.every((i) => i.layout.sizing.w === "fill");
  // Cut off by both edges around one item in the middle of the clip: a centred carousel, on
  // the item drawn there. The design's first paint has it centred, so the carousel starts on it.
  const middle = clip.x + clip.w / 2;
  const centredOn = items.findIndex((i) => Math.abs(box(i).x + box(i).w / 2 - middle) <= TOL);
  const centered =
    centredOn >= 0 && items.some((i) => box(i).x < clip.x - TOL) && items.some((i) => right(box(i)) > right(clip) + TOL);
  if (centered) evidence.push(`centred on item ${centredOn + 1}`);
  const visible = round1((clip.w + gap) / (first.w + gap));
  evidence.push(`about ${visible} items on show at ${Math.round(clip.w)}px`);
  const config: CarouselConfig = {
    slidesPerView: fills ? visible : "auto",
    slidesPerGroup: 1,
    centered,
    initialSlide: centered ? centredOn : (dots?.active ?? 0),
    ...(dots ? { pages: dots.count } : {}),
    loop: false,
    autoplay: false,
  };
  const ask: string[] = [];
  if (!dots) {
    ask.push(
      `How many items does "${container.name}" hold in all? The frame shows ${items.length}. (proposed: whatever the data holds)`,
    );
  }
  ask.push(`Should "${container.name}" move on its own, and how long on each item? (proposed: no autoplay)`);
  ask.push(`After the last item, should "${container.name}" wrap around to the first? (proposed: no loop)`);
  return {
    ...base,
    kind: "carousel",
    confidence: "certain",
    evidence,
    ask,
    choice: { src: base.src, kind: "carousel", config },
    chrome,
  };
}

// ---------------------------------------------------------------------------
// Collections and arrangement
// ---------------------------------------------------------------------------

/** Art is never a container of cards, and never a card: a crest is a group of vectors. */
function isArt(n: FrameIRNode): boolean {
  return isVectorOnly(n) || isIconGroup(n);
}

/**
 * The largest set of children that are one thing repeated.
 *
 * Instances group by name: a component's variants (the active fixture card, the selected tab)
 * have different keys and shapes but one name. Everything else groups by shape.
 */
function collectionOf(container: FrameIRNode): FrameIRNode[] | undefined {
  const groups = new Map<string, FrameIRNode[]>();
  for (const child of container.children ?? []) {
    if (isArt(child) || isRule(child) || child.layout.positioning === "absolute") continue;
    const b = box(child);
    if (b.w * b.h < MIN_ITEM_AREA) continue;
    const key = child.type === "INSTANCE" ? `i:${child.name}` : `s:${child.canonicalSignature}`;
    groups.set(key, [...(groups.get(key) ?? []), child]);
  }
  let best: FrameIRNode[] | undefined;
  for (const group of groups.values()) {
    if (group.length >= 2 && group.length > (best?.length ?? 0)) best = group;
  }
  return best;
}

type Arrangement = { kind: "row" } | { kind: "column" } | { kind: "grid"; columns: number; rows: number };

function lines(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length === 0 || v - out[out.length - 1]! > TOL) out.push(v);
  }
  return out;
}

function arrangement(boxes: Box[]): Arrangement | undefined {
  const ys = lines(boxes.map((b) => b.y + b.h / 2));
  const xs = lines(boxes.map((b) => b.x + b.w / 2));
  if (ys.length === 1) return { kind: "row" };
  if (xs.length === 1) return { kind: "column" };
  // Aligned on both axes, every cell at most once: a grid. Anything else is not one arrangement.
  if (xs.length * ys.length >= boxes.length && boxes.length > Math.max(xs.length, ys.length)) {
    return { kind: "grid", columns: xs.length, rows: ys.length };
  }
  return undefined;
}

/**
 * How many items run past the clip edge on one axis, or 0 when none of them is on show at all:
 * a run entirely outside the frame is hidden content, not a carousel peeking at its next card.
 */
function cutOff(items: FrameIRNode[], clip: Box, axis: "x" | "y"): number {
  const start = (b: Box) => (axis === "x" ? b.x : b.y);
  const end = (b: Box) => (axis === "x" ? right(b) : bottom(b));
  const visible = items.some((i) => end(box(i)) > start(clip) + TOL && start(box(i)) < end(clip) - TOL);
  if (!visible) return 0;
  return items.filter((i) => start(box(i)) < start(clip) - TOL || end(box(i)) > end(clip) + TOL).length;
}

function clipOf(
  root: FrameIRNode,
  container: FrameIRNode,
  parents: Map<string, FrameIRNode | null>,
): FrameIRNode {
  let cursor: FrameIRNode | null = container;
  while (cursor) {
    if (cursor.clipsContent) return cursor;
    cursor = parents.get(cursor.id) ?? null;
  }
  // The frame's own edge is where the design stops, clipping or not.
  return root;
}

const clipBoxOf = (root: FrameIRNode, c: FrameIRNode, p: Map<string, FrameIRNode | null>) => box(clipOf(root, c, p));
const nameOfClip = (root: FrameIRNode, c: FrameIRNode, p: Map<string, FrameIRNode | null>) => clipOf(root, c, p).name;

function findById(n: FrameIRNode, id: string): FrameIRNode | undefined {
  if (n.id === id) return n;
  for (const child of n.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Designed controls
// ---------------------------------------------------------------------------

const PREV_RE = /(?:^|[^a-z])(prev|previous|back)(?:[^a-z]|$)|(arrow|chevron|caret)[_\s-]?left(?:[^a-z]|$)/i;
const NEXT_RE = /(?:^|[^a-z])(next|forward)(?:[^a-z]|$)|(arrow|chevron|caret)[_\s-]?right(?:[^a-z]|$)/i;

function direction(name: string): "prev" | "next" | undefined {
  const prev = PREV_RE.test(name);
  const next = NEXT_RE.test(name);
  return prev === next ? undefined : prev ? "prev" : "next";
}

/**
 * The direction a control points, from the glyph inside it first: a design names the button
 * "back/next" for both and tells them apart by the icon it holds.
 */
function directionOf(n: FrameIRNode): "prev" | "next" | undefined {
  const inner = new Set<"prev" | "next">();
  const walk = (c: FrameIRNode) => {
    const d = direction(c.name);
    if (d) inner.add(d);
    for (const k of c.children ?? []) walk(k);
  };
  for (const k of n.children ?? []) walk(k);
  if (inner.size === 1) return [...inner][0];
  return direction(n.name);
}

/**
 * The carousel's designed arrows and dots: searched in the container and up to a few levels
 * above it, never inside the items (a card's own CTA arrow is not a control of the row).
 */
function controlsNear(
  container: FrameIRNode,
  items: FrameIRNode[],
  parents: Map<string, FrameIRNode | null>,
): LayoutChrome {
  const skip = new Set(items.map((i) => i.id));
  const row: Box = {
    x: Math.min(...items.map((i) => box(i).x)),
    y: Math.min(...items.map((i) => box(i).y)),
    w: Math.max(...items.map((i) => right(box(i)))) - Math.min(...items.map((i) => box(i).x)),
    h: Math.max(...items.map((i) => bottom(box(i)))) - Math.min(...items.map((i) => box(i).y)),
  };
  let scope: FrameIRNode | null = container;
  for (let level = 0; scope && level <= CONTROL_SEARCH_DEPTH; level++) {
    const found: LayoutChrome = {};
    const walk = (n: FrameIRNode) => {
      if (skip.has(n.id)) return;
      const b = box(n);
      // Outermost first: the 40px button, not the 20px glyph inside it.
      if (b.w <= MAX_CONTROL_PX && b.h <= MAX_CONTROL_PX) {
        const d = directionOf(n);
        if (d && !found[d]) {
          found[d] = n.id;
          return;
        }
      }
      if (!found.pagination && dotsOf(n) && b.y >= row.y + row.h / 2 && b.x < right(row) && right(b) > row.x) {
        found.pagination = n.id;
        return;
      }
      for (const child of n.children ?? []) walk(child);
    };
    walk(scope);
    if (found.prev || found.next || found.pagination) return found;
    scope = parents.get(scope.id) ?? null;
  }
  return {};
}

/**
 * Two arrows side by side on one line are prev then next, whatever their layers are called: a
 * visitor reads the one at the start as "back". A design whose names point the other way to the
 * order it draws them in (a library icon named `arrow_right` that draws "←") is read by
 * position. Swaps `chrome` in place; true when it did.
 */
function byPosition(chrome: LayoutChrome, root: FrameIRNode): boolean {
  if (!chrome.prev || !chrome.next) return false;
  const prev = box(findById(root, chrome.prev)!);
  const next = box(findById(root, chrome.next)!);
  const oneLine = Math.abs(prev.y + prev.h / 2 - (next.y + next.h / 2)) <= TOL;
  if (!oneLine || prev.x <= next.x) return false;
  [chrome.prev, chrome.next] = [chrome.next, chrome.prev];
  return true;
}

/**
 * A row of pagination dots: two or more small marks on one line, alike but for exactly one,
 * the active page, drawn in another fill or wider (a pill).
 */
function dotsOf(n: FrameIRNode): { count: number; active: number } | undefined {
  const kids = n.children ?? [];
  // Two marks are too common to mean pages (a clip-path pair, an icon's two halves).
  if (kids.length < MIN_ITEMS || kids.length > 20) return undefined;
  if (kids.some((k) => box(k).w > MAX_DOT_PX.w || box(k).h > MAX_DOT_PX.h || k.text !== undefined)) return undefined;
  // A dot is a mark: a shape, or a frame around one. Never a group of artwork.
  if (kids.some((k) => (k.children ?? []).some((g) => (g.children ?? []).length > 0))) return undefined;
  if (lines(kids.map((k) => box(k).y + box(k).h / 2)).length !== 1) return undefined;
  const looks = kids.map((k) => `${paintOf(k)}|${Math.round(box(k).w)}`);
  const counts = new Map<string, number>();
  for (const look of looks) counts.set(look, (counts.get(look) ?? 0) + 1);
  if (counts.size !== 2) return undefined;
  const odd = [...counts.entries()].find(([, c]) => c === 1);
  if (!odd || (kids.length > 2 && counts.get(looks.find((l) => l !== odd[0])!) !== kids.length - 1)) return undefined;
  // Two dots differ either way round; the active one is the filled or the wider one.
  const active = looks.indexOf(odd[0]);
  return { count: kids.length, active };
}

/** What a mark is painted with: its own fill and stroke, or its single child's. */
function paintOf(n: FrameIRNode): string {
  const own = (n.fill?.tokenRef ?? n.fill?.raw ?? "") + "/" + (n.stroke?.tokenRef ?? n.stroke?.raw ?? "");
  if (own !== "/") return own;
  const kids = n.children ?? [];
  return kids.length === 1 ? paintOf(kids[0]!) : "";
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Every text of a subtree, in order. */
function textsOf(n: FrameIRNode): FrameIRNode[] {
  const out: FrameIRNode[] = [];
  const walk = (c: FrameIRNode) => {
    if (c.text !== undefined) out.push(c);
    for (const k of c.children ?? []) walk(k);
  };
  walk(n);
  return out;
}

/**
 * A row of label items where exactly one is drawn differently: its own paint, or its label's.
 * A row of cards is not tabs, so each item is one short label and nothing more.
 */
function tabsOf(container: FrameIRNode, items: FrameIRNode[]): { options: string[]; active: number } | undefined {
  if (items.length < 2) return undefined;
  const labels = items.map(textsOf);
  if (labels.some((l) => l.length !== 1)) return undefined;
  if (items.some((i) => box(i).h > MAX_CONTROL_PX)) return undefined;
  const looks = items.map((item, i) => `${paintOf(item)}|${paintOf(labels[i]![0]!)}`);
  const counts = new Map<string, number>();
  for (const look of looks) counts.set(look, (counts.get(look) ?? 0) + 1);
  if (counts.size !== 2) return undefined;
  const odd = [...counts.entries()].find(([, c]) => c === 1);
  if (!odd) return undefined;
  void container;
  return {
    options: labels.map((l) => l[0]!.text!.characters.trim()),
    active: looks.indexOf(odd[0]),
  };
}

/** For a person reading the intents: one line each. */
export function describeIntent(intent: LayoutIntent): string {
  const sure: Record<Confidence, string> = { certain: "certain", likely: "likely", unsure: "UNSURE" };
  return `${intent.kind} (${sure[intent.confidence]}) "${intent.name}" [${intent.src}]: ${intent.evidence.join("; ")}`;
}
