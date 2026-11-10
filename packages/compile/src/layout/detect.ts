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

import {
  confidenceOf,
  type CarouselConfig,
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
  if (!items) return segmentedControl(root, container, parents);
  const arranged = arrangement(items.map(box));
  if (!arranged) return undefined;

  const clip = clipBoxOf(root, container, parents);
  const first = box(items[0]!);
  const evidence: string[] = [];
  const base = {
    src: container.id,
    name: container.name,
    items: items.map((i) => i.id),
    context: contextOf(container, items, clip, parents),
  };

  if (arranged.kind === "grid") {
    if (items.length < MIN_ITEMS) return undefined;
    evidence.push(`${items.length} matching items on ${arranged.columns} columns and ${arranged.rows} rows`);
    const choice: LayoutChoice = {
      src: container.id,
      kind: "grid",
      config: { columns: arranged.columns, rows: arranged.rows },
    };
    return { ...base, kind: "grid", confidence: "likely", score: 0.7, evidence, ask: [], choice, chrome: {} };
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
      score: below > 0 ? 0.9 : 0.7,
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
  // Each kind of evidence has a weight; they add up to a score for "this is a carousel". What the
  // frame shows (a card cut off, a designed arrow, dots) is enough alone; the rest only adds up.
  const carouselEvidence: string[] = [];
  let strong = 0;
  if (cutBefore + cutAfter > 0) {
    strong += 0.9;
    carouselEvidence.push(
      cutBefore > 0 && cutAfter > 0
        ? `items cut off by both edges of "${nameOfClip(root, container, parents)}"`
        : `${cutBefore + cutAfter} of ${items.length} items cut off by the edge of "${nameOfClip(root, container, parents)}"`,
    );
  }
  if (chrome.prev || chrome.next) {
    strong += 0.9;
    const parts = [chrome.prev && "previous", chrome.next && "next"].filter(Boolean).join(" and ");
    carouselEvidence.push(`a designed ${parts} arrow`);
    if (byPosition(chrome, root)) carouselEvidence.push("the arrows' names point the other way to their order: read by position");
  }
  if (dots) {
    strong += 0.9;
    carouselEvidence.push(`${dots.count} pagination dots, page ${dots.active + 1} drawn active`);
  }

  if (carouselEvidence.length > 0) {
    return carousel(
      base,
      container,
      items,
      clip,
      chrome,
      dots,
      [`${items.length} matching items in one row`, ...carouselEvidence],
      Math.min(1, strong),
    );
  }

  // Two labels are tabs only as one control (a segmented toggle): apart, they are two buttons.
  if (items.length >= MIN_ITEMS || touching(items) || namedTabs(container, items)) {
    const tabs = tabsIntent(base, container, items, [`${items.length} matching items in one row`]);
    if (tabs) return tabs;
  }

  if (items.length < MIN_ITEMS) return undefined;
  evidence.push(`${items.length} matching items in one row`);

  if (/\b(menu|nav|navigation)\b/i.test(container.name)) {
    evidence.push("named as navigation");
    return { ...base, kind: "row", confidence: "likely", score: 0.75, evidence, ask: [], choice: { src: container.id, kind: "row" }, chrome: {} };
  }

  // Nothing is cut off and nothing is drawn to move it: the weaker signs add up. A static frame
  // of a carousel looks like this, and so does a fixed row, so the score is rarely high.
  const weak = weakCarouselSignals(root, container, items, clip, parents);
  const c = Math.max(0, Math.min(1, weak.score));
  if (c < CAROUSEL_DOUBT) {
    evidence.push(...weak.against, `all ${items.length} fit inside "${nameOfClip(root, container, parents)}"`);
    return { ...base, kind: "row", confidence: "likely", score: round2(1 - c), evidence, ask: [], choice: { src: container.id, kind: "row" }, chrome: {} };
  }
  evidence.push(...weak.for, `all ${items.length} fit inside "${nameOfClip(root, container, parents)}"; no arrows or dots`, ...weak.against);
  const asCarousel = carousel(base, container, items, clip, chrome, dots, [...evidence], c);
  const row: LayoutChoice = { src: container.id, kind: "row" };
  if (c >= 0.6) {
    return { ...asCarousel, score: round2(c), confidence: confidenceOf(c, true), alternative: "row", alternativeChoice: row, alternativeAsk: [] };
  }
  return {
    ...base,
    kind: "row",
    confidence: confidenceOf(1 - c, true),
    score: round2(1 - c),
    alternative: "carousel",
    alternativeChoice: asCarousel.choice,
    alternativeAsk: asCarousel.ask,
    evidence,
    ask: [
      `Is "${container.name}" a fixed row of ${items.length}, or a carousel that scrolls when there are more than ${items.length}? (proposed: a fixed row)`,
    ],
    choice: row,
    chrome: {},
  };
}

/** Below this carousel score a row is a row: nothing about it asks to move. */
const CAROUSEL_DOUBT = 0.35;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Layer names that mean "this scrolls", on the container or the layer holding it. */
const SLIDER_NAME = /(slider|carou?sel|swiper|slides?\b|scroller|scrollable|\brail\b|\bstrip\b)/i;

/**
 * The signs of a carousel in a row whose items all fit: each adds its weight, a sign against takes
 * it off. None is proof; together they say how likely a designer meant a slider.
 */
function weakCarouselSignals(
  root: FrameIRNode,
  container: FrameIRNode,
  items: FrameIRNode[],
  clip: Box,
  parents: Map<string, FrameIRNode | null>,
): { score: number; for: string[]; against: string[] } {
  const up: string[] = [];
  const down: string[] = [];
  let score = 0;
  const first = box(items[0]!);
  const fills = items.every((i) => i.layout.sizing.w === "fill");
  const parent = parents.get(container.id);
  if (SLIDER_NAME.test(container.name) || (parent && SLIDER_NAME.test(parent.name))) {
    score += 0.5;
    up.push(`a layer is named as a slider ("${SLIDER_NAME.test(container.name) ? container.name : parent!.name}")`);
  }
  const cards = first.w >= CARD.w && first.h >= CARD.h;
  if (!fills && cards && items.length >= 4) {
    score += items.length >= 6 ? 0.35 : 0.25;
    up.push(`${items.length} items, each at a fixed width: a row that long is usually paged`);
  }
  if (cards) {
    score += 0.15;
    up.push("the items are cards, not chips");
  }
  const extent = Math.max(...items.map((i) => right(box(i)))) - Math.min(...items.map((i) => box(i).x));
  if (extent >= clip.w * 0.9) {
    score += 0.15;
    up.push("the row runs edge to edge of what clips it");
  }
  if (container.clipsContent) score += 0.05;
  if (fills) {
    score -= 0.3;
    down.push("the items share the row's width: a fixed row, not slides");
  }
  if (items.length === 3) {
    score -= 0.1;
    down.push("three items fit a row without moving");
  }
  void root;
  return { score, for: up, against: down };
}

/** The container's surroundings in plain lines, for whoever has to judge what it is. */
function contextOf(
  container: FrameIRNode,
  items: FrameIRNode[],
  clip: Box,
  parents: Map<string, FrameIRNode | null>,
): string[] {
  const first = box(items[0]!);
  const gaps = items.slice(1).map((it, i) => round1(box(it).x - right(box(items[i]!))));
  const path: string[] = [];
  for (let cursor = parents.get(container.id) ?? null; cursor && path.length < 3; cursor = parents.get(cursor.id) ?? null) {
    path.push(cursor.name);
  }
  const lines = [
    `layer "${container.name}"${path.length > 0 ? ` inside ${path.map((n) => `"${n}"`).join(" in ")}` : ""}`,
    `${items.length} items of ${Math.round(first.w)}x${Math.round(first.h)}px, sized ${items.every((i) => i.layout.sizing.w === "fill") ? "to share the row" : "at their own width"}, gaps ${[...new Set(gaps)].join("/") || "none"}px`,
    `clipped to ${Math.round(clip.w)}px wide${container.clipsContent ? " by this layer" : ""}`,
  ];
  const labels = items.slice(0, 3).map((it) =>
    textsOf(it)
      .slice(0, 5)
      .map((t) => t.text!.characters.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .join(" | "),
  );
  if (labels.some(Boolean)) lines.push(`first items read: ${labels.map((l) => `[${l.slice(0, 80)}]`).join(" ")}`);
  // the nearest words above the row: a heading, a "view all" link
  const near = parents.get(container.id);
  if (near) {
    const words = (near.children ?? [])
      .filter((s) => s.id !== container.id && s.text !== undefined)
      .map((s) => s.text!.characters.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (words.length > 0) lines.push(`beside it: ${words.map((w) => `"${w.slice(0, 40)}"`).join(", ")}`);
  }
  return lines;
}

function carousel(
  base: { src: string; name: string; items: string[]; context: string[] },
  container: FrameIRNode,
  items: FrameIRNode[],
  clip: Box,
  chrome: LayoutChrome,
  dots: { count: number; active: number } | undefined,
  evidence: string[],
  score: number,
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
    confidence: confidenceOf(score, false),
    score: round2(score),
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
    const walk = (n: FrameIRNode, labelled = false) => {
      if (skip.has(n.id)) return;
      const b = box(n);
      // Outermost first: the 40px button, not the 20px glyph inside it.
      if (!labelled && b.w <= MAX_CONTROL_PX && b.h <= MAX_CONTROL_PX) {
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
      // An arrow inside a button that carries a label ("VIEW MORE →") is that button's glyph, a
      // link to somewhere else, not a control of the row: an arrow button has no words.
      const inLabelled = labelled || (b.h <= MAX_CONTROL_PX && textsOf(n).length > 0);
      for (const child of n.children ?? []) walk(child, inLabelled);
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
  let active = looks.findIndex((look) => counts.get(look) === 1);
  if (items.length === 2) {
    // Each of two is the odd one out: the selected one is the one with a background of its own.
    const filled = items.flatMap((item, i) => (item.fill ? [i] : []));
    if (filled.length !== 1) return undefined;
    active = filled[0]!;
  }
  if (active < 0) return undefined;
  void container;
  return { options: labels.map((l) => l[0]!.text!.characters.trim()), active };
}

type IntentBase = Pick<LayoutIntent, "src" | "name" | "items" | "context">;

function tabsIntent(
  base: IntentBase,
  container: FrameIRNode,
  items: FrameIRNode[],
  evidence: string[],
): LayoutIntent | undefined {
  const tabs = tabsOf(container, items);
  if (!tabs) return undefined;
  evidence.push(
    `each item is one label, and only "${tabs.options[tabs.active]}" is drawn differently: the selected tab`,
  );
  const named = namedTabs(container, items);
  if (named) evidence.push("the layers are named as tabs");
  return {
    ...base,
    kind: "tabs",
    confidence: named ? "certain" : "likely",
    score: named ? 0.9 : 0.7,
    evidence,
    ask: [],
    choice: { src: container.id, kind: "tabs", config: tabs },
    chrome: {},
  };
}

function namedTabs(container: FrameIRNode, items: FrameIRNode[]): boolean {
  return /\btabs?\b/i.test(container.name) || items.every((i) => /\btabs?\b/i.test(i.name));
}

/** Side by side with no gap between them: one control in parts, not separate buttons. */
function touching(items: FrameIRNode[]): boolean {
  const boxes = items.map(box).sort((a, b) => a.x - b.x);
  return boxes.every((b, i) => i === 0 || Math.abs(b.x - right(boxes[i - 1]!)) <= TOL);
}

/**
 * A segmented toggle (WOMEN | MEN): two or more labels side by side, touching, one drawn as
 * selected. The selected segment often carries a fill or a stray mark the others lack, so its
 * shape differs and `collectionOf` does not see one repeated item: its parts are read here.
 */
function segmentedControl(
  root: FrameIRNode,
  container: FrameIRNode,
  parents: Map<string, FrameIRNode | null>,
): LayoutIntent | undefined {
  const items = (container.children ?? []).filter(
    (c) => !isArt(c) && !isRule(c) && c.layout.positioning !== "absolute",
  );
  if (items.length < 2 || items.length !== (container.children ?? []).length) return undefined;
  if (arrangement(items.map(box))?.kind !== "row" || !touching(items)) return undefined;
  const clip = clipBoxOf(root, container, parents);
  const base = {
    src: container.id,
    name: container.name,
    items: items.map((i) => i.id),
    context: contextOf(container, items, clip, parents),
  };
  return tabsIntent(base, container, items, [`${items.length} labels side by side as one control`]);
}

/** For a person reading the intents: one line each. */
export function describeIntent(intent: LayoutIntent): string {
  const sure: Record<Confidence, string> = { certain: "certain", likely: "likely", unsure: "UNSURE" };
  return `${intent.kind} (${sure[intent.confidence]}) "${intent.name}" [${intent.src}]: ${intent.evidence.join("; ")}`;
}
