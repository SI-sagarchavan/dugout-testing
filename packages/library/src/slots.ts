/**
 * Which parts of a frame are its background, its bands and its slots
 * (`.scratch/page-sections/spec.md`).
 *
 * - A **background** is a full-width layer that is only pictures, vectors and masks (or a shape
 *   alone): painted behind, never a section, never bound.
 * - A **slot** is a part that shows one kind of data: a heading row, its content and its controls
 *   (arrows, a pager), or one layer the designer grouped that holds all of them.
 * - A **band** is the slots that share a background; a slot with none of its own is a band alone.
 *
 * PURE: boxes and types only. No pictures, no filesystem. The section library cuts pictures from
 * the result; frame-match reads the slots.
 */

import { area, type IrDoc, type IrNode, type Rect } from "./ir.ts";

export interface Slot {
  /** The id of the slot's first layer, from the top. */
  id: string;
  /** Its heading's text, slugged, else its first layer's name. */
  name: string;
  /** The layers of the slot, top to bottom: the frame's own children, or the frame itself. */
  nodes: string[];
  /** What layout detection named the outermost container inside it, or `none`. */
  layout: string;
  /** The slot opens with a heading (its own row, or one inside the layer the designer grouped). */
  heading: boolean;
  confidence: "sure" | "unsure";
  /** Why it is unsure. */
  why?: string;
}

export interface Band {
  id: string;
  /** The background layers behind the band's slots; none when the band has no background. */
  background: string[];
  /** The layers of all its slots. */
  nodes: string[];
  slots: Slot[];
}

export interface FoundSlots {
  /** Every background layer of the frame, bands' and others'. */
  background: string[];
  bands: Band[];
}

/** Narrower than this is a control, not a section. */
export const MIN_SECTION_WIDTH = 120;
export const MIN_SECTION_HEIGHT = 40;
/** A child this wide, of its frame, is a band of the page. */
export const FULL_WIDTH = 0.8;
/** A lone child covering this much of its parent is a wrapper, looked through. */
const WRAPPER_COVER = 0.9;
/** A row shorter than this that holds text is a heading. */
const HEADING_HEIGHT = 80;
/** A heading row is at least this wide, of what holds it. */
const HEADING_WIDTH = 0.5;

/** Looks through a lone child that fills its parent: a page is often one frame inside another. */
export function unwrap(root: IrNode): IrNode {
  let node = root;
  for (;;) {
    const only = node.children?.length === 1 ? node.children[0] : undefined;
    if (!only?.children?.length) return node;
    if (area(only.geometry.bbox) < area(node.geometry.bbox) * WRAPPER_COVER) return node;
    node = only;
  }
}

export function findSlots(
  doc: IrDoc,
  opts: { layouts?: ReadonlyArray<{ src: string; kind: string }> } = {},
): FoundSlots {
  const layoutOf = new Map((opts.layouts ?? []).map((l) => [l.src, l.kind]));
  const frame = unwrap(doc.root);
  const width = frame.geometry.bbox.w;
  const children = [...(frame.children ?? [])].sort(
    (a, b) => a.geometry.bbox.y - b.geometry.bbox.y || a.geometry.bbox.x - b.geometry.bbox.x,
  );

  // what the designer marked comes before every rule below
  const marked = marksOnChildren(frame, marksOf(doc));
  const background: IrNode[] = [];
  const rest: IrNode[] = [];
  for (const child of children) {
    const mark = marked.get(child.id);
    const behind = mark ? mark.kind === "background" : isBackground(child, width);
    (behind ? background : rest).push(child);
  }

  // slots: a heading waits for the content under it; controls join the slot around them
  type Draft = {
    nodes: IrNode[];
    heading: boolean;
    content: boolean;
    lead: boolean;
    /** The section name a designer marked it with. */
    mark?: string;
  };
  const drafts: Draft[] = [];
  let waiting: IrNode[] = [];
  const controls: IrNode[] = [];
  for (const child of rest) {
    const box = child.geometry.bbox;
    const mark = marked.get(child.id)?.name;
    if (mark) {
      // layers marked alike are one section, wherever they are; an unmarked heading above joins it
      const same = drafts.find((d) => d.mark === mark);
      if (same) same.nodes.push(...waiting, child);
      else
        drafts.push({
          nodes: [...waiting, child],
          heading: waiting.length > 0 || holdsHeading(child),
          content: true,
          lead: waiting.length > 0,
          mark,
        });
      waiting = [];
    } else if (box.w < MIN_SECTION_WIDTH || box.h < MIN_SECTION_HEIGHT) {
      controls.push(child);
    } else if (isHeading(child, width)) {
      waiting.push(child);
    } else {
      drafts.push({
        nodes: [...waiting, child],
        heading: waiting.length > 0 || holdsHeading(child),
        content: true,
        lead: waiting.length > 0,
      });
      waiting = [];
    }
  }
  // a heading with nothing under it stands alone
  if (waiting.length > 0)
    drafts.push({ nodes: waiting, heading: true, content: false, lead: true });
  // layers side by side, on one row, show one thing: the cards of a list the designer laid out
  for (let i = drafts.length - 1; i > 0; i--) {
    const a = drafts[i - 1] as Draft;
    const b = drafts[i] as Draft;
    if (!a.content || !b.content || b.lead || a.mark || b.mark) continue;
    const row = spanOf(a.nodes.slice(-1));
    if (sameRow(row, (b.nodes[0] as IrNode).geometry.bbox)) {
      a.nodes.push(...b.nodes);
      drafts.splice(i, 1);
    }
  }

  if (drafts.length === 0) {
    // nothing to split: the frame is one slot
    return one(frame, layoutOf, background);
  }
  for (const control of controls) {
    const slot = nearest(drafts, control.geometry.bbox);
    slot.nodes.push(control);
  }

  const slots: Slot[] = drafts.map((d) => {
    const nodes = [...d.nodes].sort((a, b) => a.geometry.bbox.y - b.geometry.bbox.y);
    const first = nodes[0] as IrNode;
    return {
      id: first.id,
      name: d.mark ?? nameOf(nodes),
      nodes: nodes.map((n) => n.id),
      layout: layoutIn(nodes, layoutOf),
      heading: d.heading,
      confidence: "sure" as const,
    };
  });
  judge(slots, drafts);
  // a section the designer marked is what they said it is
  slots.forEach((slot, i) => {
    if (!drafts[i]?.mark) return;
    slot.confidence = "sure";
    delete slot.why;
  });

  // a band: the slots a background lies behind; the others are bands of their own
  const bands: Band[] = [];
  for (const back of background) {
    const behind = slots.filter(
      (s, i) =>
        overlaps(back.geometry.bbox, spanOf(drafts[i]?.nodes ?? [])) &&
        !bands.some((b) => b.slots.includes(s)),
    );
    if (behind.length > 0) bands.push(band(behind, [back.id]));
  }
  for (const s of slots) if (!bands.some((b) => b.slots.includes(s))) bands.push(band([s], []));
  bands.sort((a, b) => order(a, slots) - order(b, slots));
  return { background: background.map((b) => b.id), bands };
}

function band(slots: Slot[], background: string[]): Band {
  return {
    id: `band:${slots[0]?.id}`,
    background,
    nodes: slots.flatMap((s) => s.nodes),
    slots,
  };
}

const order = (b: Band, slots: Slot[]) => slots.indexOf(b.slots[0] as Slot);

function one(frame: IrNode, layoutOf: Map<string, string>, background: IrNode[]): FoundSlots {
  const slot: Slot = {
    id: frame.id,
    name: nameOf([frame]),
    nodes: [frame.id],
    layout: layoutIn([frame], layoutOf),
    heading: holdsHeading(frame),
    confidence: "sure",
  };
  return {
    background: background.map((b) => b.id),
    bands: [{ id: `band:${frame.id}`, background: [], nodes: slot.nodes, slots: [slot] }],
  };
}

/** Two content slots with no heading between them, or a heading with no content, are unsure. */
function judge(slots: Slot[], drafts: ReadonlyArray<{ content: boolean }>) {
  slots.forEach((slot, i) => {
    if (!drafts[i]?.content) {
      slot.confidence = "unsure";
      slot.why = "a heading with no content under it";
      return;
    }
    if (slot.heading) return;
    const next = slots[i + 1];
    const before = slots[i - 1];
    const neighbour = [before, next].find((n) => n && !n.heading);
    if (neighbour) {
      slot.confidence = "unsure";
      slot.why = `no heading between it and ${neighbour.id}: one section or two?`;
    }
  });
}

/** The slot a control belongs to: the one whose vertical range holds it, else the closest. */
function nearest<T extends { nodes: IrNode[] }>(drafts: T[], box: Rect): T {
  let best = drafts[0] as T;
  let distance = Number.POSITIVE_INFINITY;
  for (const d of drafts) {
    const span = spanOf(d.nodes);
    const gap = Math.max(span.y - (box.y + box.h), box.y - (span.y + span.h), 0);
    if (gap < distance) {
      distance = gap;
      best = d;
    }
  }
  return best;
}

function spanOf(nodes: IrNode[]): Rect {
  const top = Math.min(...nodes.map((n) => n.geometry.bbox.y));
  const bottom = Math.max(...nodes.map((n) => n.geometry.bbox.y + n.geometry.bbox.h));
  const left = Math.min(...nodes.map((n) => n.geometry.bbox.x));
  const right = Math.max(...nodes.map((n) => n.geometry.bbox.x + n.geometry.bbox.w));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Two boxes share most of their height: they are side by side. */
const sameRow = (a: Rect, b: Rect) =>
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > Math.min(a.h, b.h) / 2;

/** Whether `back` lies behind `span` at all: they share some of their height. */
const overlaps = (back: Rect, span: Rect) =>
  Math.min(back.y + back.h, span.y + span.h) - Math.max(back.y, span.y) > span.h / 2;

/** Full width, and only pictures, vectors and masks (or a shape alone). */
function isBackground(node: IrNode, width: number): boolean {
  if (node.geometry.bbox.w < width * FULL_WIDTH) return false;
  if (!node.children?.length) return true;
  return picturesOnly(node);
}

function picturesOnly(node: IrNode): boolean {
  if (node.type === "TEXT" || node.type === "INSTANCE" || node.type === "COMPONENT") return false;
  return (node.children ?? []).every(picturesOnly);
}

const hasText = (node: IrNode): boolean =>
  node.type === "TEXT" || (node.children ?? []).some(hasText);

/** A short, wide row that holds text, tabs or a button. */
function isHeading(node: IrNode, width: number): boolean {
  const box = node.geometry.bbox;
  return box.h < HEADING_HEIGHT && box.w >= width * HEADING_WIDTH && hasText(node);
}

/** A layer the designer grouped that opens with a heading row of its own. */
function holdsHeading(node: IrNode): boolean {
  const box = node.geometry.bbox;
  if (box.h < HEADING_HEIGHT * 1.5) return false;
  const find = (n: IrNode, depth: number): boolean =>
    (n.children ?? []).some(
      (c) =>
        (isHeading(c, box.w) && c.geometry.bbox.y <= box.y + HEADING_HEIGHT) ||
        (depth < 3 && find(c, depth + 1)),
    );
  return find(node, 0);
}

function layoutIn(nodes: IrNode[], layoutOf: Map<string, string>): string {
  let found = "none";
  const walk = (n: IrNode): boolean => {
    const kind = layoutOf.get(n.id);
    if (kind && kind !== "none") {
      found = kind;
      return true;
    }
    return (n.children ?? []).some(walk);
  };
  nodes.some(walk);
  return found;
}

/** The slot's heading text, slugged, else its first layer's name. */
function nameOf(nodes: IrNode[]): string {
  const first = nodes[0] as IrNode;
  const top = first.geometry.bbox.y;
  const texts: IrNode[] = [];
  const walk = (n: IrNode) => {
    if (n.type === "TEXT" && n.text?.characters?.trim() && n.geometry.bbox.y < top + HEADING_HEIGHT)
      texts.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(first);
  // the heading is the biggest words of the first row, the leftmost of those
  texts.sort(
    (a, b) =>
      (b.text?.fontSize ?? 0) - (a.text?.fontSize ?? 0) || a.geometry.bbox.x - b.geometry.bbox.x,
  );
  const title = texts[0]?.text?.characters?.trim();
  return slug(title && title.length <= 60 ? title : (nodes[0]?.name ?? "")) || "section";
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * What a designer marked (ticket 03): a layer that is a section, with its name, or one that is
 * background. Marked by a layer name (`section/<name>`, `background` or `background/…`) or by a
 * designer note of kind `section` (its text is the section's name) or `background`. Layers marked
 * with the same section name are one section.
 */
export interface Mark {
  target: string;
  kind: "section" | "background";
  name?: string;
}

export function marksOf(doc: IrDoc): Mark[] {
  const marks: Mark[] = [];
  const walk = (n: IrNode) => {
    const named = /^\s*(section|background)\s*(?:\/\s*(.*))?$/i.exec(n.name ?? "");
    if (named) {
      const kind = (named[1] as string).toLowerCase() as Mark["kind"];
      const name = named[2]?.trim();
      if (kind === "background") marks.push({ target: n.id, kind });
      else if (name) marks.push({ target: n.id, kind, name });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(doc.root);
  const notes = Array.isArray(doc.annotations) ? doc.annotations : [];
  for (const note of notes) {
    if (!note || typeof note !== "object") continue;
    const { targetId, kind, text } = note as { targetId?: unknown; kind?: unknown; text?: unknown };
    if (typeof targetId !== "string") continue;
    if (kind === "background") marks.push({ target: targetId, kind });
    if (kind === "section" && typeof text === "string" && text.trim()) {
      marks.push({ target: targetId, kind, name: text.trim() });
    }
  }
  return marks;
}

/**
 * The marks, each on the frame's child that holds its layer. A child marked two ways (two section
 * names, or a section and background) keeps no mark: the finder's own rules decide it.
 */
function marksOnChildren(frame: IrNode, marks: Mark[]): Map<string, Mark> {
  const top = new Map<string, string>();
  for (const child of frame.children ?? []) {
    const walk = (n: IrNode) => {
      top.set(n.id, child.id);
      for (const c of n.children ?? []) walk(c);
    };
    walk(child);
  }
  const on = new Map<string, Mark>();
  const clash = new Set<string>();
  for (const mark of marks) {
    const child = top.get(mark.target);
    if (!child) continue;
    const had = on.get(child);
    const named = mark.name ? slug(mark.name) || "section" : undefined;
    if (had && (had.kind !== mark.kind || had.name !== named)) clash.add(child);
    else on.set(child, { ...mark, ...(named ? { name: named } : {}) });
  }
  for (const child of clash) on.delete(child);
  return on;
}
