/**
 * Which parts of a frame are sections, and where each one's picture is.
 *
 * A Handoff is either a page (sections stacked down it) or one section on its own. A page's
 * sections are its full-width children that hold layers (a full-width picture alone is a
 * background); one section is the frame itself. Inside either, every
 * container layout detection names (ADR 0024: a carousel, a grid, tabs…) is a section too, one
 * level down. Repeats of one shape within the frame give one section.
 *
 * Pictures come from the Handoff's plates: the section's own when the plugin exported one,
 * otherwise cut from the nearest plate that covers it (the whole frame's, or a section's around a
 * sub-section), otherwise put together from the plates of the layers inside it.
 *
 * PURE. No filesystem, no network, no image decoding: the caller passes plate sizes in and makes
 * the pictures from the returned plans itself.
 */

import { contains, type IrDoc, type IrNode, indexNodes, pictureBox, type Rect } from "./ir.ts";
import { findSlots, MIN_SECTION_HEIGHT, MIN_SECTION_WIDTH, unwrap } from "./slots.ts";

/** A picture in the Handoff, of one layer. `ref` is how the caller reads its bytes. */
export interface Plate {
  nodeId: string;
  name: string;
  ref: string;
  width: number;
  height: number;
}

/** What layout detection said one container is (`@fanos/compile` `detectLayout`). */
export interface LayoutHint {
  src: string;
  kind: string;
}

export interface SectionCandidate {
  nodeId: string;
  name: string;
  /** 0: a section of the page (or the frame itself); 1: a container inside one. */
  level: 0 | 1;
  /** The level-0 section a level-1 one is inside. */
  parentId: string | null;
  /** The root node's layout box, frame coordinates. */
  box: Rect;
  /** What layout detection named it, or `none`. */
  layout: string;
  signature: string;
  crop: CropPlan;
}

/** One plate's part of a section's picture: a rectangle of its pixels, and where it goes. */
export interface CropPart {
  plate: Plate;
  from: Rect;
  to: Rect;
}

/**
 * How to make a section's picture: one part when a plate holds all of it, several when it is put
 * together from the plates of layers inside it, later ones painted over earlier ones.
 */
export interface CropPlan {
  width: number;
  height: number;
  parts: CropPart[];
}

export interface SkippedSection {
  nodeId: string;
  name: string;
  reason: string;
}

/** Pictures of layers inside a section must cover this much of it to make its picture. */
export const COMPOSE_COVER = 0.9;
/** How far, in a plate's pixels, its size may be from its layer's box at the plate's scale. */
const PLATE_SLACK = 2;

export function findSections(
  doc: IrDoc,
  opts: {
    plates: readonly Plate[];
    layouts?: readonly LayoutHint[];
    /** The section's signature: shape only, over its whole subtree. */
    sign: (node: IrNode) => string;
  },
): { sections: SectionCandidate[]; skipped: SkippedSection[] } {
  const nodes = indexNodes(doc.root);
  const layoutOf = new Map((opts.layouts ?? []).map((l) => [l.src, l.kind]));
  const sections: SectionCandidate[] = [];
  const skipped: SkippedSection[] = [];
  const seen = new Map<string, string>();

  const consider = (node: IrNode, level: 0 | 1, parentId: string | null) => {
    const box = node.geometry.bbox;
    if (box.w < MIN_SECTION_WIDTH || box.h < MIN_SECTION_HEIGHT) {
      skipped.push({ nodeId: node.id, name: node.name, reason: "too small to be a section" });
      return false;
    }
    if (!node.children?.length) {
      skipped.push({ nodeId: node.id, name: node.name, reason: "a single layer, not a section" });
      return false;
    }
    const signature = opts.sign(node);
    const same = seen.get(signature);
    if (same) {
      skipped.push({ nodeId: node.id, name: node.name, reason: `the same shape as ${same}` });
      return false;
    }
    const crop = cropFor(node, nodes, opts.plates, behind.get(node.id));
    if ("problem" in crop) {
      skipped.push({ nodeId: node.id, name: node.name, reason: crop.problem });
      return false;
    }
    seen.set(signature, node.id);
    sections.push({
      nodeId: node.id,
      name: node.name,
      level,
      parentId,
      box,
      layout: layoutOf.get(node.id) ?? "none",
      signature,
      crop,
    });
    return true;
  };

  const frame = unwrap(doc.root);
  // the slots of the frame, each as the one layer that holds it, or, for a slot of several
  // layers, a layer made to hold them: its picture and shape are of all of them
  const found = findSlots(doc, { layouts: opts.layouts ?? [] });
  const slots = found.bands.flatMap((b) => b.slots);
  // what the band paints behind a slot is part of the slot's picture
  const behind = new Map(
    found.bands.flatMap((b) => b.slots.map((slot) => [slot.id, b.background] as const)),
  );
  const tops =
    slots.length >= 2
      ? slots.map((slot) => holding(slot.nodes.map((id) => nodes.get(id)?.node as IrNode)))
      : [frame];

  for (const top of tops) {
    if (!consider(top, 0, null)) continue;
    // containers detection named, inside this section, outermost first
    const inside: IrNode[] = [];
    const walk = (node: IrNode) => {
      for (const child of node.children ?? []) {
        const kind = layoutOf.get(child.id);
        if (kind && kind !== "none") inside.push(child);
        walk(child);
      }
    };
    walk(top);
    for (const node of inside) consider(node, 1, top.id);
  }
  return { sections, skipped };
}

/** One layer standing for several: the first one's id, a box around all, all as children. */
export function holding(layers: IrNode[]): IrNode {
  const [first] = layers;
  if (!first || layers.length === 1) return first as IrNode;
  const x0 = Math.min(...layers.map((n) => n.geometry.bbox.x));
  const y0 = Math.min(...layers.map((n) => n.geometry.bbox.y));
  const x1 = Math.max(...layers.map((n) => n.geometry.bbox.x + n.geometry.bbox.w));
  const y1 = Math.max(...layers.map((n) => n.geometry.bbox.y + n.geometry.bbox.h));
  const { renderBbox: _drop, ...geometry } = first.geometry;
  // a plain, fixed-size frame around them, with the rest of the first layer's layout kept
  return {
    id: first.id,
    name: first.name,
    type: "FRAME",
    layout: { ...first.layout, mode: "none", sizing: { w: "fixed", h: "fixed" } },
    geometry: { ...geometry, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } },
    children: layers,
  };
}

/**
 * The section's picture: cut from its own plate or the nearest one around it, or, when there is
 * none, put together from the plates of the layers inside it (the plugin often sends a frame's
 * children and not the frame). Pictures of single art layers (`art-…`) are only used for that
 * layer itself.
 */
export function cropFor(
  node: IrNode,
  nodes: ReturnType<typeof indexNodes>,
  plates: readonly Plate[],
  behind: readonly string[] = [],
): CropPlan | { problem: string } {
  const byNode = new Map<string, Plate>();
  for (const plate of plates) if (!byNode.has(plate.nodeId)) byNode.set(plate.nodeId, plate);

  let problem = "no picture in the Handoff covers it";
  for (let id: string | null = node.id; id; id = nodes.get(id)?.parent ?? null) {
    const plate = byNode.get(id);
    const owner = nodes.get(id)?.node;
    if (!plate || !owner) continue;
    if (id !== node.id && plate.name.startsWith("art-")) continue;
    const placed = place(plate, owner, node);
    if ("rect" in placed) {
      const { rect } = placed;
      return {
        width: rect.w,
        height: rect.h,
        parts: [{ plate, from: rect, to: { x: 0, y: 0, w: rect.w, h: rect.h } }],
      };
    }
    problem = placed.problem;
  }
  return compose(node, nodes, byNode, behind) ?? { problem };
}

/** A picture put together from several, at the scale of the least detailed of them. */
function compose(
  node: IrNode,
  nodes: ReturnType<typeof indexNodes>,
  byNode: Map<string, Plate>,
  behind: readonly string[] = [],
): CropPlan | { problem: string } | undefined {
  const order = new Map([...nodes.keys()].map((id, i) => [id, i]));
  // a section made of several layers (`holding`) is not in the index: its layers are its members
  const made = nodes.get(node.id)?.node !== node;
  const members = new Set(made ? (node.children ?? []).map((c) => c.id) : [node.id]);
  // layers painted behind the section count, cut to it
  for (const id of behind) members.add(id);
  const inside = (id: string) => {
    if ((made || behind.includes(id)) && members.has(id)) return true;
    for (let up = nodes.get(id)?.parent ?? null; up; up = nodes.get(up)?.parent ?? null) {
      if (members.has(up)) return true;
    }
    return false;
  };
  // the outermost plated layers inside the section, in paint order
  const plated = [...byNode.values()]
    .filter((p) => !p.name.startsWith("art-") && inside(p.nodeId))
    .filter((p) => {
      for (
        let up = nodes.get(p.nodeId)?.parent ?? null;
        up && !members.has(up);
        up = nodes.get(up)?.parent ?? null
      ) {
        if (byNode.has(up) && !byNode.get(up)?.name.startsWith("art-")) return false;
      }
      return true;
    })
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0));
  const section = node.geometry.bbox;
  const lined = plated.flatMap((plate) => {
    const owner = nodes.get(plate.nodeId)?.node;
    const fit = owner ? lineUp(plate, owner) : undefined;
    const visible = fit ? intersect(fit.box, section) : undefined;
    return fit && visible ? [{ plate, ...fit, visible }] : [];
  });
  if (lined.length === 0) return undefined;

  const cover = coverage(
    section,
    lined.map((l) => l.visible),
  );
  if (cover < COMPOSE_COVER) {
    return {
      problem: `no picture of it, and the pictures of layers inside it cover ${Math.round(cover * 100)}%`,
    };
  }
  const scale = Math.min(...lined.map((l) => l.scale));
  const parts = lined.map(({ plate, box, scale: own, visible }) => ({
    plate,
    from: pixels(visible, box, own, plate),
    to: {
      x: Math.round((visible.x - section.x) * scale),
      y: Math.round((visible.y - section.y) * scale),
      w: Math.max(1, Math.round(visible.w * scale)),
      h: Math.max(1, Math.round(visible.h * scale)),
    },
  }));
  return {
    width: Math.max(1, Math.round(section.w * scale)),
    height: Math.max(1, Math.round(section.h * scale)),
    parts,
  };
}

/** How `plate`, a picture of `owner`, lines up with it: its box, shadows included or not, and scale. */
function lineUp(plate: Plate, owner: IrNode): { box: Rect; scale: number } | undefined {
  // the plugin exports a layer with its shadows when it has any: try that box, then the layout one
  for (const box of [pictureBox(owner), owner.geometry.bbox]) {
    if (box.w <= 0 || box.h <= 0) continue;
    const scale = plate.width / box.w;
    if (Math.abs(plate.height - box.h * scale) <= PLATE_SLACK + scale) return { box, scale };
  }
  return undefined;
}

/** Where `node` is in the pixels of `plate`, a picture of `owner`. */
function place(plate: Plate, owner: IrNode, node: IrNode): { rect: Rect } | { problem: string } {
  const fit = lineUp(plate, owner);
  if (!fit) return { problem: `${plate.name} does not line up with its layer` };
  const target = pictureBox(node);
  // a section drawing past its plate's edge is cut to the plate
  if (!contains(fit.box, target, 1) && !contains(fit.box, node.geometry.bbox, 1)) {
    return { problem: `${plate.name} does not hold all of it` };
  }
  const rect = pixels(target, fit.box, fit.scale, plate);
  if (rect.w < 1 || rect.h < 1) return { problem: `${plate.name} shows none of it` };
  return { rect };
}

/** `r`, in frame coordinates, as pixels of a plate of `box` at `scale`, cut to the plate. */
function pixels(r: Rect, box: Rect, scale: number, plate: Plate): Rect {
  const x0 = clamp(Math.round((r.x - box.x) * scale), 0, plate.width);
  const y0 = clamp(Math.round((r.y - box.y) * scale), 0, plate.height);
  const x1 = clamp(Math.round((r.x + r.w - box.x) * scale), 0, plate.width);
  const y1 = clamp(Math.round((r.y + r.h - box.y) * scale), 0, plate.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/** How much of `area` the rectangles cover, counted on a grid of about 400 cells a side. */
function coverage(within: Rect, rects: readonly Rect[]): number {
  const cell = Math.max(1, Math.max(within.w, within.h) / 400);
  let covered = 0;
  let total = 0;
  for (let y = within.y + cell / 2; y < within.y + within.h; y += cell) {
    for (let x = within.x + cell / 2; x < within.x + within.w; x += cell) {
      total++;
      if (rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) covered++;
    }
  }
  return total ? covered / total : 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
