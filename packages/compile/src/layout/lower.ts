/**
 * Lowering: a decided layout (`LayoutChoice`) applied to the compiled tree.
 *
 * Pure: (tree, IR, choices) → tree. The IR is read again for the facts a choice does not carry
 * (which nodes are the items, which are the designed controls, where the active slide sits), so
 * a choice stays small enough for a person to read and edit, and a recompile applies it again.
 *
 * `carousel` and `tabs` change the tree. `list` and `row` are what the compiler already drew.
 * `grid` is detected and recorded, and left as compiled until the renderer draws it from these
 * intents: a note says so, rather than a half-lowered tree.
 *
 * Tabs stay as drawn: each item becomes one option of a page choice (`select`), and the look the
 * design gives the selected one becomes its `active` state, so pressing another moves the look
 * (`page.ts`). The first paint is the frame.
 */

import { type FlatNode, type FlatTree, type LayoutChoice, type LayoutChrome, type LayoutIntent, PAGE_SCOPE, pageKeyOf, pageValueOf } from "@fanos/dsl";
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
  /** Container srcs whose layout was applied: Carousels, and tabs made options of a page choice. */
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
    if (choice.kind === "grid") {
      notes.push({ src: choice.src, message: `${choice.kind} recorded; not lowered yet, so it stays as compiled` });
      continue;
    }
    if (choice.kind === "tabs") {
      const container = nodes.find((n) => n.src === choice.src);
      // the tabs the choice names, else the ones the IR shows
      const tabsIntent = choice.items ? ({ items: choice.items } as LayoutIntent) : intents.get(choice.src);
      const result = container
        ? lowerTabs(nodes, container, choice.config, tabsIntent)
        : "the compiler did not keep this container as a node";
      if (typeof result === "string") {
        notes.push({ src: choice.src, message: result });
        continue;
      }
      lowered.push(choice.src);
      notes.push({ src: choice.src, message: result.made });
      continue;
    }
    const node = nodes.find((n) => n.src === choice.src);
    if (choice.slide && choice.slide.length > 0) {
      // the design draws only the slide on show: its layers become the one slide of a new carousel
      const aside: string[] = [];
      const made = node
        ? lowerOneSlide(nodes, node, choice.slide, choice.chrome ?? {}, choice.config, ir, aside)
        : "the compiler did not keep this container as a node";
      if (typeof made === "string") {
        notes.push({ src: choice.src, message: made });
        continue;
      }
      lowered.push(choice.src);
      notes.push({ src: choice.src, message: [made.made, ...aside].join("; ") });
      continue;
    }
    // what the choice names, else what the IR shows
    const detected = intents.get(choice.src);
    const intent = choice.items
      ? { items: choice.items, chrome: { ...(detected?.chrome ?? {}), ...(choice.chrome ?? {}) } }
      : detected
        ? { items: detected.items, chrome: { ...detected.chrome, ...(choice.chrome ?? {}) } }
        : undefined;
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
  intent: { items: string[]; chrome: LayoutChrome },
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
  wireControls(nodes, node, intent.chrome, config, ir, aside);
  return undefined;
}

/**
 * The designed arrows, dots and counter stay as drawn, wired to the carousel. What a frame cannot
 * draw, their look in a state, comes from the config; an arrow with nowhere to go fades without
 * one. A counter writes the slide on show in the form the design drew ("01", "1 / 5"). A progress
 * bar is wired only on a carousel that moves on its own (`wireProgress`); otherwise it stays as
 * drawn.
 */
function wireControls(
  nodes: FlatNode[],
  carousel: FlatNode,
  chrome: LayoutChrome,
  config: CarouselConfig,
  ir: Map<string, FrameIRNode>,
  aside: string[],
): void {
  const looks = config.controls;
  const arrows: FlatNode[] = [];
  for (const part of ["prev", "next", "pagination", "counter"] as const) {
    const src = chrome[part];
    const control = src ? nodes.find((n) => n.src === src) : undefined;
    if (!control) continue;
    if (part === "counter") {
      if (control.type !== "Text" || typeof control.props.content !== "string") {
        aside.push(`the counter ${src} is not a text: left as drawn`);
        continue;
      }
      control.props = {
        ...control.props,
        controlFor: { target: carousel.id, part, format: counterFormat(control.props.content) },
      };
      continue;
    }
    control.props = { ...control.props, controlFor: { target: carousel.id, part } };
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
  if (chrome.progress) wireProgress(nodes, carousel, chrome.progress, config, ir, aside);
  if (looks?.arrows?.placement === "edges") {
    const why = toEdges(nodes, arrows);
    if (why) aside.push(`arrows left where they are drawn: ${why}`);
  }
}

/** A bar is a thin line; the segment drawn on a track is one too, within a few pixels of it. */
const MAX_BAR_PX = 8;
const ON_TRACK_PX = 4;

/**
 * The progress bar of a carousel that moves on its own shows the time gone on the slide: the
 * renderer fills it by scale, from nothing to its whole width, once per slide. A design draws that
 * as a track with a short segment at its start (the time gone so far); the segment becomes the bar,
 * as wide as the track, and the track stays as drawn under it. A bar drawn alone is filled itself.
 * Without autoplay nothing moves it, and it stays as drawn.
 */
function wireProgress(
  nodes: FlatNode[],
  carousel: FlatNode,
  src: string,
  config: CarouselConfig,
  ir: Map<string, FrameIRNode>,
  aside: string[],
): void {
  if (config.autoplay === false) {
    aside.push("the progress bar stays as drawn: the carousel does not move on its own, so nothing fills it");
    return;
  }
  const track = nodes.find((n) => n.src === src);
  const box = ir.get(src)?.geometry.bbox;
  if (!track || !box) {
    aside.push(`the progress bar ${src} is not in the tree: nothing to fill`);
    return;
  }
  if (box.h > box.w) {
    aside.push("the progress bar stays as drawn: a bar that fills downwards is not wired yet");
    return;
  }
  const controlFor = { target: carousel.id, part: "progress" };
  const segment = nodes.find((n) => {
    if (n === track || n.parent !== track.parent) return false;
    const b = ir.get(n.src)?.geometry.bbox;
    if (!b || b.h > MAX_BAR_PX || b.w >= box.w) return false;
    const onTrack = Math.abs(b.y + b.h / 2 - (box.y + box.h / 2)) <= ON_TRACK_PX;
    return onTrack && Math.abs(b.x - box.x) <= 1 && b.x + b.w <= box.x + box.w + 1;
  });
  if (!segment) {
    track.props = { ...track.props, controlFor };
    return;
  }
  const meta = { ...((segment.props._meta as Record<string, unknown> | undefined) ?? {}) };
  const deviations = [...((meta.deviations as unknown[] | undefined) ?? [])];
  deviations.push({
    check: "C2",
    reason: "the segment drawn on the progress track is the bar: as wide as the track, filled as the slide's time runs out",
    max: 1,
  });
  segment.props = {
    ...segment.props,
    size: { ...((segment.props.size as Record<string, unknown> | undefined) ?? {}), w: { raw: round(box.w), _unbound: true } },
    controlFor,
    _meta: { ...meta, deviations },
  };
}

/** The counter's text in the form the design drew it: "01" → "0{index}", "1 / 5" → "{index} / {count}". */
export function counterFormat(drawn: string): string {
  const text = drawn.trim();
  const pad = (digits: string) => (digits.length > 1 && digits.startsWith("0") ? "0".repeat(digits.length - 1) : "");
  const pair = /^(\d+)(\s*(?:\/|of)\s*)(\d+)$/i.exec(text);
  if (pair) return `${pad(pair[1]!)}{index}${pair[2]}${pad(pair[3]!)}{count}`;
  const one = /^(\d+)$/.exec(text);
  if (one) return `${pad(one[1]!)}{index}`;
  return "{index} / {count}";
}

/**
 * A carousel the design draws one slide of: a hero whose photo, shade, words and button are all
 * the slide on show, laid over by its arrows and a counter. Those layers are children of
 * `container`, placed where they are drawn; they become the one slide of a new carousel that fills
 * the container, and each keeps its place inside the slide, so the first paint is the frame. The
 * data repeats the slide (one per item). Returns what was made, or why nothing was.
 */
function lowerOneSlide(
  nodes: FlatNode[],
  container: FlatNode,
  slide: string[],
  chrome: LayoutChrome,
  config: CarouselConfig,
  ir: Map<string, FrameIRNode>,
  aside: string[],
): { made: string } | string {
  if (container.type !== "Overlay" && container.type !== "Box") {
    return `its slide's layers sit in a ${container.type}, which lays them out; only layers placed where they are drawn (an Overlay) can become one slide`;
  }
  const kids = nodes.filter((n) => n.parent === container.id).sort((a, b) => a.idx - b.idx);
  const wanted = new Set(slide);
  const parts = kids.filter((k) => wanted.has(k.src));
  const lost = slide.filter((src) => !parts.some((p) => p.src === src));
  if (parts.length === 0) return "none of the slide's layers is a child of this container in the tree";
  if (lost.length > 0) aside.push(`${lost.length} layer(s) of the slide are not in the tree as children here: ${lost.join(", ")}`);
  const at = parts.map((p) => kids.indexOf(p));
  const from = Math.min(...at);
  const to = Math.max(...at);
  const between = kids.slice(from, to + 1).filter((k) => !wanted.has(k.src));
  if (between.length > 0) {
    return `the slide's layers are not one run: ${between.map((b) => b.src).join(", ")} sits between them, and moving it would change what draws over what`;
  }
  const box = ir.get(container.src)?.geometry.bbox;
  if (!box) return "the container is not in the IR, so the slide's size is unknown";
  const height = { _unbound: true, raw: round(box.h) };
  const idOf = (base: string) => {
    let id = base;
    let n = 2;
    while (nodes.some((x) => x.id === id)) id = `${base}_${n++}`;
    return id;
  };
  const synthetic = (src: string) => {
    let n = 1;
    while (nodes.some((x) => x.src === `synthetic:${src}:${n}`)) n++;
    return `synthetic:${src}:${n}`;
  };
  const props: Record<string, unknown> = {
    place: { anchor: "top-fill" },
    size: { h: height },
    clip: true,
    slidesPerView: 1,
    loop: config.loop,
    autoplay: config.autoplay === false ? false : { delay: { raw: config.autoplay.delayMs, _unbound: true } },
  };
  if (config.initialSlide > 0) props.initialSlide = config.initialSlide;
  for (const key of CAROUSEL_MOTION) {
    const value = config.props?.[key];
    if (value !== undefined) props[key] = value;
  }
  const carousel: FlatNode = {
    id: idOf(`${container.id}_carousel`),
    parent: container.id,
    idx: from,
    src: synthetic(container.src),
    type: "Carousel",
    props,
  } as FlatNode;
  nodes.push(carousel);
  const one: FlatNode = {
    id: idOf(`${container.id}_slide`),
    parent: carousel.id,
    idx: 0,
    src: synthetic(container.src),
    type: "Overlay",
    props: { size: { w: "full", h: height }, clip: true },
  } as FlatNode;
  nodes.push(one);
  parts.forEach((p, i) => {
    p.parent = one.id;
    p.idx = i;
  });
  // idx stays a run from 0 under the container, the carousel where the slide's layers were
  const rest = kids.filter((k) => !wanted.has(k.src));
  [...rest.slice(0, from), carousel, ...rest.slice(from)].forEach((k, i) => (k.idx = i));
  wireControls(nodes, carousel, chrome, config, ir, aside);
  return { made: `carousel of one drawn slide (${parts.length} layers), repeated for each item the data holds` };
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

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type TabsConfig = Extract<LayoutChoice, { kind: "tabs" }>["config"];

/** The look a state can move: a node's surface and fill, and its label's tone. */
interface TabLook {
  surface?: unknown;
  fill?: unknown;
  tone?: unknown;
}

/**
 * Makes each tab one option of a page choice, keeping every one as drawn. Returns why it could
 * not, or what it made.
 *
 * The design draws one tab selected. What differs between it and the others (a surface, a fill,
 * the label's colour) becomes a state: the tabs take the plain look, and the selected look is
 * their `active` state (or, when only the plain ones paint, theirs is `inactive`). What only the
 * selected tab draws (an underline, a dot) is copied to every tab and shown while it is chosen.
 */
function lowerTabs(
  nodes: FlatNode[],
  container: FlatNode,
  config: TabsConfig,
  intent: LayoutIntent | undefined,
): { made: string } | string {
  const kidsOf = (id: string) => nodes.filter((n) => n.parent === id).sort((a, b) => a.idx - b.idx);
  const items = intent
    ? intent.items.map((src) => nodes.find((n) => n.src === src && n.parent === container.id))
    : kidsOf(container.id);
  if (items.length !== config.options.length || items.some((i) => i === undefined)) {
    return "its tabs are not each one node of the tree, so they stay as compiled";
  }
  const tabs = items as FlatNode[];
  const selected = tabs[config.active];
  const plain = tabs.find((_, i) => i !== config.active);
  if (!selected || !plain) return "no tab is drawn selected, so they stay as compiled";

  const key = config.key ?? pageKeyOf(config.options);
  const values = uniqueValues(config.options);
  const subtree = (id: string): FlatNode[] => [nodes.find((n) => n.id === id)!, ...kidsOf(id).flatMap((k) => subtree(k.id))];
  const labelOf = (tab: FlatNode) => subtree(tab.id).find((n) => n.type === "Text");
  const lookOf = (tab: FlatNode): TabLook => ({
    surface: tab.props.surface,
    fill: tab.props.fill,
    tone: labelOf(tab)?.props.tone,
  });

  // Each prop on its own: the side that paints it is the state; both paint it, the selected is.
  const on = lookOf(selected);
  const off = lookOf(plain);
  const base: TabLook = {};
  const active: TabLook = {};
  const inactive: TabLook = {};
  for (const prop of ["surface", "fill", "tone"] as const) {
    const a = on[prop];
    const b = off[prop];
    if (JSON.stringify(a) === JSON.stringify(b)) {
      base[prop] = a;
    } else if (a !== undefined && b === undefined) {
      active[prop] = a;
    } else if (a === undefined && b !== undefined) {
      inactive[prop] = b;
    } else {
      base[prop] = b;
      active[prop] = a;
    }
  }
  // a Resp surface cannot be a state's, which takes one token
  for (const look of [active, inactive]) {
    for (const prop of ["surface", "fill", "tone"] as const) {
      if (look[prop] !== undefined && typeof look[prop] !== "string") {
        return `the selected tab's ${prop} differs by breakpoint, which a state cannot hold: they stay as compiled`;
      }
    }
  }

  // What only the selected tab draws: its children beside the one that holds the label.
  const holdsLabel = (tab: FlatNode, kid: FlatNode) => subtree(kid.id).some((n) => n.id === labelOf(tab)?.id);
  const marks = kidsOf(selected.id).filter((k) => !holdsLabel(selected, k));
  const plainMarks = kidsOf(plain.id).filter((k) => !holdsLabel(plain, k));
  const copied = plainMarks.length === 0 ? marks : [];

  const states = (tab: FlatNode) => {
    const own = (tab.props.states as Record<string, object> | undefined) ?? {};
    const next: Record<string, object> = { ...own };
    if (Object.keys(active).length) next.active = { ...(own.active ?? {}), ...active };
    if (Object.keys(inactive).length) next.inactive = { ...(own.inactive ?? {}), ...inactive };
    return next;
  };
  tabs.forEach((tab, i) => {
    const props: Record<string, unknown> = { ...tab.props };
    for (const prop of ["surface", "fill"] as const) {
      if (base[prop] === undefined) delete props[prop];
      else props[prop] = base[prop];
    }
    const next = states(tab);
    if (Object.keys(next).length) props.states = next;
    props.select = { key, value: values[i]!, ...(i === config.active ? { initial: true } : {}) };
    tab.props = props;
    const label = labelOf(tab);
    if (label) {
      if (base.tone === undefined) delete label.props.tone;
      else label.props = { ...label.props, tone: base.tone };
    }
  });

  // The selected tab's own marks, on every tab, each shown while its tab is chosen.
  const shownFor = (props: Record<string, unknown>, value: string) => {
    const mine = { path: `${PAGE_SCOPE}.${key}`, eq: value };
    const own = props.when;
    return own === undefined ? mine : [...(Array.isArray(own) ? own : [own]), mine];
  };
  let made = 0;
  const syntheticOf = (src: string) => {
    const base = src.startsWith("synthetic:") ? src.slice("synthetic:".length).replace(/:\d+$/, "") : src;
    let n = 1;
    while (nodes.some((x) => x.src === `synthetic:${base}:${n}`)) n++;
    return `synthetic:${base}:${n}`;
  };
  for (const mark of copied) {
    tabs.forEach((tab, i) => {
      if (tab === selected) return;
      const ids = new Map<string, string>();
      const copy = subtree(mark.id).map((n) => {
        const id = `${n.id}__${values[i]}`;
        ids.set(n.id, id);
        return { ...structuredClone(n), id };
      });
      for (const n of copy) {
        n.parent = n.parent === mark.parent ? tab.id : ids.get(n.parent!)!;
        n.src = syntheticOf(n.src);
        nodes.push(n);
      }
      const root = copy[0]!;
      root.props = { ...root.props, when: shownFor(root.props, values[i]!) };
      // in the same place among the tab's children as in the selected one's
      for (const sibling of nodes) {
        if (sibling.parent === tab.id && sibling !== root && sibling.idx >= mark.idx) sibling.idx += 1;
      }
      root.idx = Math.min(mark.idx, nodes.filter((n) => n.parent === tab.id && n !== root).length);
      made++;
    });
    mark.props = { ...mark.props, when: shownFor(mark.props, values[config.active]!) };
  }
  // idx stays a run from 0 under each tab
  for (const tab of tabs) kidsOf(tab.id).forEach((k, i) => (k.idx = i));

  const looks = [
    ...Object.keys(active).map((p) => `${p} when chosen`),
    ...Object.keys(inactive).map((p) => `${p} when not`),
  ];
  return {
    made: [
      `tabs: ${config.options.length} options of _page.${key} (${values.join(", ")}), "${values[config.active]}" first`,
      looks.length ? `the selected look moves with the choice: ${looks.join(", ")}` : "every tab looks the same: nothing shows which is chosen",
      ...(made ? [`${copied.length} mark(s) only the selected tab draws, copied to each tab and shown while it is chosen`] : []),
    ].join("; "),
  };
}

/** Each label's value, unique: two tabs called "ALL" are `all` and `all_2`. */
function uniqueValues(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const value = pageValueOf(label);
    const n = (seen.get(value) ?? 0) + 1;
    seen.set(value, n);
    return n === 1 ? value : `${value}_${n}`;
  });
}
