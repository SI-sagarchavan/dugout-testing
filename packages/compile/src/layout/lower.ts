/**
 * Lowering: a decided layout (`LayoutChoice`) applied to the compiled tree.
 *
 * Pure: (tree, IR, choices) → tree. The IR is read again for the facts a choice does not carry
 * (which nodes are the items, which are the designed controls, where the active slide sits), so
 * a choice stays small enough for a person to read and edit, and a recompile applies it again.
 *
 * Only `carousel` changes the tree today. `list` and `row` are what the compiler already drew.
 * `grid` and `tabs` are detected and recorded, and left as compiled until the renderer draws them
 * from these intents: a note says so, rather than a half-lowered tree.
 */

import type { FlatNode, FlatTree, LayoutChoice, LayoutIntent } from "@fanos/dsl";
import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";
import { detectLayout } from "./detect.js";

export interface LowerNote {
  src: string;
  message: string;
}

export interface LowerResult {
  tree: FlatTree;
  /** One per choice: what was done, or why nothing was. */
  notes: LowerNote[];
  /** Container srcs that became Carousels. */
  lowered: string[];
}

/** Stack props that mean nothing on a Carousel: Swiper lays the slides out. */
const STACK_ONLY = ["direction", "align", "justify", "wrap", "gap", "clip"];

export function lowerLayout(tree: FlatTree, doc: FrameIRDocument, choices: LayoutChoice[]): LowerResult {
  const nodes = structuredClone(tree.nodes) as FlatNode[];
  const notes: LowerNote[] = [];
  const lowered: string[] = [];
  const intents = new Map(detectLayout(doc).map((i) => [i.src, i]));
  const ir = new Map<string, FrameIRNode>();
  const index = (n: FrameIRNode) => {
    ir.set(n.id, n);
    for (const child of n.children ?? []) index(child);
  };
  index(doc.root);

  for (const choice of choices) {
    if (choice.kind === "list" || choice.kind === "row") {
      notes.push({ src: choice.src, message: `kept as compiled: a ${choice.kind} is what the frame draws` });
      continue;
    }
    if (choice.kind === "grid" || choice.kind === "tabs") {
      notes.push({ src: choice.src, message: `${choice.kind} recorded; not lowered yet, so it stays as compiled` });
      continue;
    }
    const intent = intents.get(choice.src);
    const node = nodes.find((n) => n.src === choice.src);
    if (!intent || !node) {
      notes.push({
        src: choice.src,
        message: !intent
          ? "no matching items in this container, so there is nothing to make slides of"
          : "the compiler did not keep this container as a node",
      });
      continue;
    }
    const aside: string[] = [];
    const why = lowerCarousel(nodes, node, intent, choice.config, ir, aside);
    if (why) {
      notes.push({ src: choice.src, message: why });
      continue;
    }
    lowered.push(choice.src);
    const made = `carousel of ${nodes.filter((n) => n.parent === node.id).length} slides`;
    notes.push({ src: choice.src, message: [made, ...aside].join("; ") });
  }
  return { tree: { ...tree, nodes }, notes, lowered };
}

type CarouselConfig = Extract<LayoutChoice, { kind: "carousel" }>["config"];

/** Rewrites `node` in place; returns why it could not, or undefined. */
function lowerCarousel(
  nodes: FlatNode[],
  node: FlatNode,
  intent: LayoutIntent,
  config: CarouselConfig,
  ir: Map<string, FrameIRNode>,
  /** What was not done, on a carousel that was made. */
  aside: string[],
): string | undefined {
  if (node.type !== "Stack" || node.props.direction !== "row") {
    return `compiled as a ${node.type}${node.type === "Stack" ? " column" : ""}, not a row: left as it is`;
  }
  const props = { ...node.props } as Record<string, unknown>;
  const isRoot = node.parent === null;
  const items = intent.items.map((id) => ir.get(id)!).filter(Boolean);
  const first = items[0]!.geometry.bbox;
  const active = items[config.initialSlide]?.geometry.bbox;

  // Inline padding is where the first slide starts and the last one stops: Swiper's offsets.
  // Block padding stays padding.
  const space = { ...((props.space as Record<string, unknown> | undefined) ?? {}) };
  const offsetBefore = space.pl ?? space.px ?? space.p;
  const offsetAfter = space.pr ?? space.px ?? space.p;
  if (space.p !== undefined) space.py = space.py ?? space.p;
  delete space.p;
  delete space.px;
  delete space.pl;
  delete space.pr;

  const carousel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) if (!STACK_ONLY.includes(key) && key !== "space") carousel[key] = value;
  if (Object.keys(space).length > 0) carousel.space = space;

  if (config.centered && active) {
    // Wider than what clips it, offset to centre one card: the carousel is the clip's width,
    // and Swiper does the centring. Only an anchored row inside its clip can be moved there.
    const place = props.place as { anchor?: string; offset?: { block?: unknown } } | undefined;
    if (!place?.anchor?.startsWith("top")) {
      return "a centred row that is not placed inside its clip: left as it is";
    }
    carousel.place = { anchor: "top-fill", ...(place.offset?.block ? { offset: { block: place.offset.block } } : {}) };
    const size = { ...((props.size as Record<string, unknown> | undefined) ?? {}) };
    delete size.w;
    if (Object.keys(size).length > 0) carousel.size = size;
    else delete carousel.size;
    delete carousel.column;
    carousel.centered = true;
    // Centred mid-strip, but the ends sit at the edges: no empty space before the first slide
    // or after the last, which the design never draws.
    carousel.centeredBounds = true;
    carousel.centerAt = round(active.x + active.w / 2 - first.x);
    // The box moves on purpose: the row was drawn wider than its clip and offset to centre a
    // card; the carousel is the clip's width and centres it by scrolling. One finding, this box.
    const meta = { ...((props._meta as Record<string, unknown> | undefined) ?? {}) };
    const deviations = [...((meta.deviations as unknown[] | undefined) ?? [])];
    deviations.push({
      check: "C2",
      reason: "a centred carousel is as wide as the clip it scrolls in, not the row drawn wider than it",
      max: 1,
    });
    carousel._meta = { ...meta, deviations };
  } else {
    if (offsetBefore !== undefined) carousel.offsetBefore = offsetBefore;
    if (offsetAfter !== undefined) carousel.offsetAfter = offsetAfter;
  }
  if (props.gap !== undefined) carousel.gap = props.gap;
  if (typeof props.align === "string" && props.align !== "baseline") carousel.align = props.align;

  // The frame's own edge is where a design stops; inside a page, a row that did not clip lets
  // its slides run on until whatever clips above it.
  carousel.clip = isRoot || props.clip === true;

  carousel.slidesPerView = config.slidesPerView;
  if (config.slidesPerGroup !== 1) carousel.slidesPerGroup = config.slidesPerGroup;
  if (config.initialSlide > 0) carousel.initialSlide = config.initialSlide;
  carousel.loop = config.loop;
  carousel.autoplay = config.autoplay === false ? false : { delay: { raw: config.autoplay.delayMs, _unbound: true } };
  // How it moves, when a person or a platform config said: never where it sits.
  for (const key of CAROUSEL_MOTION) {
    const value = config.props?.[key];
    if (value !== undefined) carousel[key] = value;
  }

  node.type = "Carousel";
  node.props = carousel;

  // The designed arrows and dots stay as drawn, wired to the carousel. What a frame cannot draw,
  // their look in a state, comes from the config; an arrow with nowhere to go fades without one.
  const looks = config.controls;
  const arrows: FlatNode[] = [];
  for (const part of ["prev", "next", "pagination"] as const) {
    const src = intent.chrome[part];
    const control = src ? nodes.find((n) => n.src === src) : undefined;
    if (!control) continue;
    control.props = { ...control.props, controlFor: { target: node.id, part } };
    if (part === "pagination") {
      const states = looks?.pagination?.states;
      if (states) {
        for (const dot of nodes.filter((n) => n.parent === control.id)) {
          dot.props = { ...dot.props, states: { ...((dot.props.states as object | undefined) ?? {}), ...states } };
        }
      }
      continue;
    }
    arrows.push(control);
    const states = looks?.arrows?.states ?? { disabled: { opacity: "opacity.40" } };
    control.props = { ...control.props, states: { ...((control.props.states as object | undefined) ?? {}), ...states } };
  }
  if (looks?.arrows?.placement === "edges") {
    const why = toEdges(nodes, arrows);
    if (why) aside.push(`arrows left where they are drawn: ${why}`);
  }
  return undefined;
}

/**
 * Prev at the start edge, next at the end, in the row the design drew them in. Only a row of the
 * two arrows alone is moved: it is spread with `between` across the width it already has,
 * so where it sits up and down, and every other node, is unchanged.
 */
function toEdges(nodes: FlatNode[], arrows: FlatNode[]): string | undefined {
  const prev = arrows.find((a) => (a.props.controlFor as { part?: string }).part === "prev");
  const next = arrows.find((a) => (a.props.controlFor as { part?: string }).part === "next");
  if (!prev || !next) return "arrows at the edges need both a prev and a next drawn";
  if (prev.parent !== next.parent || prev.parent === null) return "the two arrows are not in one row";
  const row = nodes.find((n) => n.id === prev.parent)!;
  const siblings = nodes.filter((n) => n.parent === row.id);
  if (row.type !== "Stack" || row.props.direction !== "row" || siblings.length !== 2) {
    return "their row holds more than the two arrows";
  }
  row.props = { ...row.props, justify: "between" };
  prev.idx = 0;
  next.idx = 1;
  return undefined;
}

/** The Carousel props a choice may carry beyond its layout: how it moves, never where. */
const CAROUSEL_MOTION = [
  "effect",
  "speed",
  "easing",
  "freeMode",
  "direction",
  "rewind",
  "draggable",
  "grabCursor",
  "mousewheel",
  "keyboard",
  "slideToClicked",
  "autoHeight",
] as const;

const round = (v: number) => Math.round(v * 100) / 100;
