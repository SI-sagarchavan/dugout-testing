import { z } from "zod";
import type { ControlPlane } from "./control-plane.ts";
import type {
  Box,
  CompileNote,
  Conformed,
  IrDoc,
  IrNode,
  PngImage,
  Toolchain,
  Tree,
  TreeNode,
} from "./toolchain.ts";

const decoded = new WeakMap<Buffer, PngImage>();

/**
 * A screenshot's pixels, decoded once. A frame has dozens of crops and each looks at the same few
 * screenshots, and a tall one takes most of a second to decode. Shared, so never written to.
 */
export function plateImage(tools: Toolchain, png: Buffer): PngImage {
  let image = decoded.get(png);
  if (!image) {
    image = tools.png.read(png);
    decoded.set(png, image);
  }
  return image;
}

function copyOf(tools: Toolchain, image: PngImage): PngImage {
  const out = tools.png.create(image.width, image.height);
  image.data.copy(out.data);
  return out;
}

/** Behind a transparent plate and the render alike. Mid grey hides neither pale nor dark paint. */
export const PAGE = "#808080";
const PAGE_RGB = 0x80;
/** Figma and Chromium draw text differently, so colour within this much is the same colour. */
const DIFF_THRESHOLD = 0.1;
const MAX_FINDINGS = 12;
const MIN_NODE_MISMATCH = 12;
const MAX_SURFACES = 5;
const MIN_SURFACE_MISMATCH = 200;
/** Below this a placement by search is a guess, not a measurement. */
const MIN_ESTIMATED_MATCH = 50;
/** More words than this and a group is content, not art. */
const MAX_ART_WORDS = 2;
/** How far apart, in pixels of a screenshot, lines can be and still line up. */
const ALIGN_SLACK = 6;
/** How far a pixel, summed over red, green and blue, can be from a text's colour and be its ink. */
const INK_DISTANCE = 30;
const MIN_INK_IN_COLUMN = 3;
/** A wider gap than this, in pixels of a screenshot, is not between letters of one line. */
const MAX_INK_GAP = 24;

export interface Bundle {
  exportId: string;
  rootName: string;
  ir: unknown;
  doc: IrDoc;
  byId: Map<string, IrNode>;
  /** Figma ids in paint order: a later one is on top. */
  order: Map<string, number>;
  /** A node's parent, by Figma id; null for the root. */
  parents: Map<string, string | null>;
  /** Where a search placed a screenshot with padding, by its layer's Figma id, once measured. */
  found?: Map<string, { dx: number; dy: number }>;
  themeRaw: unknown;
  themeArtifactId: string;
  plates: Array<{ nodeId: string; name: string; png: Buffer }>;
}

/** What a designer's Send stored, by export id. Immutable, so a resumed run reads the same. */
export async function loadBundle(
  tools: Toolchain,
  plane: ControlPlane,
  exportId: string,
  pinnedTheme?: string,
): Promise<Bundle> {
  const record = await plane.getExport(exportId);
  // Pinned once chosen: a token set stored mid-run must not move the numbers under a run.
  const themeArtifactId = pinnedTheme ?? (await plane.newestArtifactId("token_set"));
  if (!themeArtifactId) throw new Error("the project has no token set");
  const ir = await plane.json(record.irArtifactId);
  const doc = tools.parseIr(ir);
  const byId = new Map<string, IrNode>();
  const order = new Map<string, number>();
  const parents = new Map<string, string | null>();
  const walk = (node: IrNode, parent: string | null) => {
    byId.set(node.id, node);
    order.set(node.id, order.size);
    parents.set(node.id, parent);
    for (const child of node.children ?? []) walk(child, node.id);
  };
  walk(doc.root, null);
  return {
    exportId,
    rootName: record.rootName ?? doc.root.name,
    ir,
    doc,
    byId,
    order,
    parents,
    themeRaw: await plane.json(themeArtifactId),
    themeArtifactId,
    plates: await Promise.all(
      record.plates.map(async (plate) => ({
        nodeId: plate.nodeId,
        name: plate.name,
        png: await plane.bytes(plate.artifactId),
      })),
    ),
  };
}

/**
 * What one frame needs that its IR and the compiler can't supply. These are inputs to a rebuild,
 * keyed by Figma id, so a recompile keeps them. The compiled tree is never edited by hand.
 */
export const Overrides = z
  .object({
    /** A layer-name slug to a glyph in the icon registry: the compiler's own `icons` option. */
    icons: z.record(z.string(), z.string()).default({}),
    /** Figma ids to draw as a crop of the screenshot: art the export has no vectors for. */
    crops: z.array(z.string()).default([]),
    /** Figma ids to leave out: their pixels are already in a crop painted under them. */
    drops: z.array(z.string()).default([]),
    /** Figma ids of text the compiler dropped for want of an exact style: added with the nearest. */
    texts: z.array(z.string()).default([]),
    /** Figma ids whose gradient paint has no token: kept raw, stops and angle read from the IR. */
    gradients: z.array(z.string()).default([]),
    /** Replace a surface the compiler named, e.g. to bind the token the design really uses. */
    surfaces: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    /** Props on the node a Figma id compiled to. The pipeline validator checks every token. */
    props: z
      .array(z.object({ src: z.string(), props: z.record(z.string(), z.unknown()) }))
      .default([]),
  })
  .strict();
export type Overrides = z.infer<typeof Overrides>;

export const noOverrides = (): Overrides => ({
  icons: {},
  crops: [],
  drops: [],
  gradients: [],
  texts: [],
  surfaces: {},
  props: [],
});

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlap = (a: Rect, b: Rect): Rect | undefined => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
};

/**
 * Where a layer shows on the page: its box cut by the frame and by every ancestor that clips. Figma
 * exports a layer as it shows, so a photo wider than its card comes out as the card's size.
 */
export function visibleBox(bundle: Bundle, id: string): Rect | undefined {
  const node = bundle.byId.get(id);
  if (!node) return undefined;
  let box: Rect | undefined = node.geometry.bbox;
  for (let up = bundle.parents.get(id); up && box; up = bundle.parents.get(up)) {
    const ancestor = bundle.byId.get(up);
    if (ancestor?.clipsContent) box = overlap(box, ancestor.geometry.bbox);
  }
  return box && overlap(box, bundle.doc.root.geometry.bbox);
}

interface ShadowEffect {
  type?: string;
  x?: number;
  y?: number;
  blur?: number;
  spread?: number;
}

/**
 * What a layer draws, as Figma exports it: its own box and whatever its children draw beyond that,
 * except that a layer that clips keeps its children inside it.
 */
function drawnBox(node: IrNode): Rect {
  const box = node.geometry.bbox;
  let x0 = box.x;
  let y0 = box.y;
  let x1 = box.x + box.w;
  let y1 = box.y + box.h;
  const reach = (drawn: Rect) => {
    x0 = Math.min(x0, drawn.x);
    y0 = Math.min(y0, drawn.y);
    x1 = Math.max(x1, drawn.x + drawn.w);
    y1 = Math.max(y1, drawn.y + drawn.h);
  };
  if (!node.clipsContent) for (const child of node.children ?? []) reach(drawnBox(child));
  // a shadow spreads past the layer by its blur, moved by its offset, and clipping doesn't cut it
  for (const effect of (node.effects ?? []) as ShadowEffect[]) {
    if (effect.type !== "DROP_SHADOW") continue;
    const blur = (effect.blur ?? 0) + (effect.spread ?? 0);
    const dx = effect.x ?? 0;
    const dy = effect.y ?? 0;
    reach({
      x: box.x + dx - blur,
      y: box.y + dy - blur,
      w: box.w + 2 * blur,
      h: box.h + 2 * blur,
    });
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The part of a layer's own box that the clipping ancestors let through, however far past the frame
 * it runs. Undefined when they show none of it.
 */
export function clipOf(bundle: Bundle, id: string): Rect | undefined {
  let box: Rect | undefined = bundle.byId.get(id)?.geometry.bbox;
  for (let up = bundle.parents.get(id); up && box; up = bundle.parents.get(up)) {
    const ancestor = bundle.byId.get(up);
    if (ancestor?.clipsContent) box = overlap(box, ancestor.geometry.bbox);
  }
  return box;
}

/** A layer's drawn box, cut by the ancestors that clip it. */
function exportedBox(bundle: Bundle, id: string): Rect | undefined {
  const node = bundle.byId.get(id);
  if (!node) return undefined;
  let box: Rect | undefined = drawnBox(node);
  for (let up = bundle.parents.get(id); up && box; up = bundle.parents.get(up)) {
    const ancestor = bundle.byId.get(up);
    if (ancestor?.clipsContent) box = overlap(box, ancestor.geometry.bbox);
  }
  return box;
}

/**
 * Where a screenshot sits on the page. Its size says which box it is: what the layer draws with its
 * overflow, or only where it shows in the frame. An exact fit on either wins over a near one.
 */
export function placeOf(
  bundle: Bundle,
  id: string,
  plate: { width: number; height: number },
): { box: Rect; fit: Fit; partial?: true } | undefined {
  // IR 1.9.0 says where a layer's pixels are, so its own picture needs no search. Older exports
  // don't, and fall through to the boxes worked out from the layout.
  const boxes = [
    bundle.byId.get(id)?.geometry.renderBbox,
    exportedBox(bundle, id),
    visibleBox(bundle, id),
  ].filter((box): box is Rect => box !== undefined);
  const fits = boxes.map((box) => ({ box, fit: fitOf(plate, box) }));
  return (
    fits.find(({ fit }) => !("problem" in fit) && fit.extraW === undefined) ??
    fits.find(({ fit }) => !("problem" in fit)) ??
    partOf(bundle, id, plate) ??
    fits[0]
  );
}

/**
 * A screenshot of the same height as its layer but narrower, of a layer running off the side of the
 * frame: a card at the end of a row, cut where the row was cut. It holds the end still in view.
 */
function partOf(
  bundle: Bundle,
  id: string,
  plate: { width: number; height: number },
): { box: Rect; fit: Fit; partial: true } | undefined {
  const box = bundle.byId.get(id)?.geometry.bbox;
  if (!box) return undefined;
  const root = bundle.doc.root.geometry.bbox;
  for (const scale of SCALES) {
    const w = plate.width / scale;
    if (Math.abs(plate.height / scale - box.h) > ROUNDING || w >= box.w - ROUNDING) continue;
    const x = box.x + box.w > root.x + root.w ? box.x : box.x < root.x ? box.x + box.w - w : null;
    if (x !== null) return { box: { x, y: box.y, w, h: box.h }, fit: { scale }, partial: true };
  }
  return undefined;
}

/**
 * A picture of one layer's art, which is cut from and never measured (IR 1.9.0). The frame's own
 * picture is not art, whatever its name.
 */
export function isArtPlate(bundle: Pick<Bundle, "doc">, plate: { name: string; nodeId: string }) {
  return plate.name.startsWith("art-") && plate.nodeId !== bundle.doc.rootNodeId;
}

/**
 * The pictures a frame is compared against. When the export holds the frame's own, that is the
 * one: it has everything in it, the root's fill included, which no section picture does, and it
 * costs one render and not one per section. Otherwise the section pictures, as before. Pictures
 * of single layers are what crops come from, not what the frame is checked against.
 */
export function measuredPlates(bundle: Pick<Bundle, "doc" | "plates">): Bundle["plates"] {
  const whole = bundle.plates.find((plate) => plate.nodeId === bundle.doc.rootNodeId);
  if (whole) return [whole];
  return bundle.plates.filter((plate) => !isArtPlate(bundle, plate));
}

/** A screenshot this much bigger than its layer is a layer with a shadow or overflow around it. */
const MAX_EXTRA = 16;
/** Rounding of a layer's box to whole pixels. */
const ROUNDING = 1;
const SCALES = [2, 1, 3, 4];

export type Fit =
  | { scale: number; extraW?: undefined; extraH?: undefined }
  | { scale: number; extraW: number; extraH: number }
  | { problem: string };

/**
 * How a screenshot lines up with its layer's visible box: exactly, or larger by a few pixels where
 * Figma drew a shadow or overflow and said not where (the caller has to find where), or not at all.
 */
export function fitOf(
  plate: { width: number; height: number },
  box: Rect | { w: number; h: number },
): Fit {
  const extra = (scale: number) =>
    [plate.width / scale - box.w, plate.height / scale - box.h] as const;
  for (const scale of SCALES) {
    const [w, h] = extra(scale);
    if (Math.abs(w) <= ROUNDING && Math.abs(h) <= ROUNDING) return { scale };
  }
  for (const scale of SCALES) {
    const [w, h] = extra(scale);
    if (w >= -ROUNDING && h >= -ROUNDING && w <= MAX_EXTRA && h <= MAX_EXTRA) {
      return { scale, extraW: Math.max(0, w), extraH: Math.max(0, h) };
    }
  }
  return {
    problem: `${plate.width}×${plate.height} does not fit the layer's ${round(box.w)}×${round(box.h)}`,
  };
}

export interface Built {
  tree: Tree;
  notes: CompileNote[];
  theme: unknown;
  themeRaw: unknown;
  surfaces: { assets: Record<string, string>; surfaces: Record<string, unknown> };
  /** Text added back with the nearest style, where no style matched the IR exactly. */
  addedTexts: Array<{ src: string; style: string; exact: boolean }>;
  /** Figma ids drawn from the screenshot. Fewer than asked for when no screenshot fits a node. */
  cropped: string[];
  themeCss: string;
  errors: string[];
  warnings: number;
  missing: string[];
}

const channels = (value: string) =>
  [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as [number, number, number];

const gradientName = (src: string) => `paint_${src.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
const gradientKey = (name: string) => `gradient_${name}_gradient`;

export interface RawGradient {
  type: "linear-gradient";
  degree: number;
  stops: Array<{ color: string; opacity: number; percent: number }>;
}

/**
 * A linear gradient as CSS draws it, from the IR's paint string. Figma's matrix says how far along
 * the gradient each point of the layer is, as `t = a*u + b*v + tx`, so a stop at `t` sits at
 * `u = (t - tx) / a` of the layer. Undefined for a paint that is not linear along one axis.
 */
export function gradientOf(node: IrNode): RawGradient | undefined {
  const raw = (node.fill as { raw?: unknown } | null | undefined)?.raw;
  if (typeof raw !== "string") return undefined;
  const match = /^GRADIENT_LINEAR\((.*);\s*m=\[(.*)\]\)$/.exec(raw);
  if (!match) return undefined;
  const [a, b, tx] = (match[2] as string).split(",").map(Number) as [number, number, number];
  const alongU = Math.abs(a) >= Math.abs(b);
  const slope = alongU ? a : b;
  const across = alongU ? b : a;
  if (!slope || Math.abs(across) > Math.abs(slope) * 0.1) return undefined;
  const rotation = node.geometry.rotation ?? 0;
  const stops: RawGradient["stops"] = [];
  for (const stop of (match[1] as string).split(/,\s*/)) {
    const parts = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?\s+([\d.]+)%$/.exec(stop.trim());
    if (!parts) return undefined;
    const at = (Number(parts[3]) / 100 - tx) / slope;
    stops.push({
      color: `#${parts[1]}`,
      opacity: round(parts[2] ? (parseInt(parts[2], 16) / 255) * 100 : 100),
      percent: round(Math.min(1, Math.max(0, slope < 0 ? 1 - at : at)) * 100),
    });
  }
  if (stops.length < 2) return undefined;
  const degree = (90 + (alongU ? 0 : 90) + (slope < 0 ? 180 : 0) + rotation + 360) % 360;
  return { type: "linear-gradient", degree, stops };
}

/** A frame's paints with no token go in a copy of its theme, so they are named and countable. */
function withGradients(raw: unknown, gradients: Map<string, RawGradient>): unknown {
  if (gradients.size === 0) return raw;
  const copy = structuredClone(raw) as {
    tokens: Record<string, { gradient?: { light?: Record<string, unknown> } }>;
  };
  for (const body of Object.values(copy.tokens)) {
    body.gradient ??= {};
    body.gradient.light ??= {};
    for (const [name, gradient] of gradients) {
      body.gradient.light[gradientKey(name)] = gradient;
    }
  }
  return copy;
}

function deleteDescendants(nodes: TreeNode[], id: string): TreeNode[] {
  const gone = new Set<string>();
  const add = (parent: string) => {
    for (const node of nodes) {
      if (node.parent === parent && !gone.has(node.id)) {
        gone.add(node.id);
        add(node.id);
      }
    }
  };
  add(id);
  return nodes.filter((node) => !gone.has(node.id));
}

/** The screenshot to crop a layer from: its own, else the smallest one that holds it. */
function plateFor(tools: Toolchain, bundle: Bundle, node: IrNode) {
  // the visible part of a layer running off the frame may be all of its screenshot
  const own = bundle.plates.find((plate) => plate.nodeId === node.id);
  const part = own && placeOf(bundle, node.id, plateImage(tools, own.png));
  if (own && part?.partial && "scale" in part.fit) {
    return { plate: own, vis: part.box, scale: part.fit.scale, rank: 0 };
  }
  const want = visibleBox(bundle, node.id);
  if (!want) return undefined;
  let best: { plate: Bundle["plates"][number]; vis: Rect; scale: number; rank: number } | undefined;
  for (const plate of bundle.plates) {
    const place = placeOf(bundle, plate.nodeId, plateImage(tools, plate.png));
    const vis = place?.box;
    const fit = place?.fit;
    const hit = vis && overlap(vis, want);
    if (!vis || !hit || !fit) continue;
    if ("problem" in fit) continue;
    // a screenshot with padding can be cropped from once a search has found where it sits
    let at = vis;
    if (fit.extraW !== undefined) {
      const offset = bundle.found?.get(plate.nodeId);
      if (!offset) continue;
      const size = plateImage(tools, plate.png);
      at = {
        x: vis.x + offset.dx,
        y: vis.y + offset.dy,
        w: size.width / fit.scale,
        h: size.height / fit.scale,
      };
    }
    const contains =
      at.x <= want.x + 0.5 &&
      at.y <= want.y + 0.5 &&
      at.x + at.w >= want.x + want.w - 0.5 &&
      at.y + at.h >= want.y + want.h - 0.5;
    // its own plate first, then the smallest that holds it, then whichever shows most of it
    const rank = plate.nodeId === node.id ? 0 : contains ? 1 + at.w * at.h : 1e12 - hit.w * hit.h;
    if (!best || rank < best.rank) best = { plate, vis: at, scale: fit.scale, rank };
  }
  return best;
}

/**
 * A plate's pixels under one Figma node, keeping transparency, padded where the node runs off the
 * plate. "offscreen" means no screenshot shows it, so nothing can be wrong with it.
 */
function cropFromPlates(
  tools: Toolchain,
  bundle: Bundle,
  node: IrNode,
  gradients: string[],
  window?: Rect,
): string | "offscreen" {
  const found = plateFor(tools, bundle, node);
  if (!found) return "offscreen";
  // a picture that fills its clipping frame is the part of the layer inside that frame
  const box = window ?? node.geometry.bbox;
  // Past a clipping edge the layer shows nothing, but the plate holds whatever else is there. Only
  // what the ancestors let through is the layer's: the rest of the crop stays transparent.
  const shows = clipOf(bundle, node.id);
  if (!shows) return "offscreen";
  const over = fadesOver(bundle, node, gradients);
  const { vis, scale } = found;
  const image = plateImage(tools, found.plate.png);
  const left = Math.round((box.x - vis.x) * scale);
  const top = Math.round((box.y - vis.y) * scale);
  const w = Math.max(1, Math.round(box.w * scale));
  const h = Math.max(1, Math.round(box.h * scale));
  const out = tools.png.create(w, h);
  out.data.fill(0);
  for (let y = 0; y < h; y++) {
    const sy = top + y;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = left + x;
      if (sx < 0 || sx >= image.width) continue;
      const from = (sy * image.width + sx) * 4;
      const to = (y * w + x) * 4;
      image.data.copy(out.data, to, from, from + 4);
      const pageX = vis.x + (sx + 0.5) / scale;
      const pageY = vis.y + (sy + 0.5) / scale;
      if (
        pageX < shows.x ||
        pageY < shows.y ||
        pageX >= shows.x + shows.w ||
        pageY >= shows.y + shows.h
      ) {
        out.data.fill(0, to, to + 4);
        continue;
      }
      for (const fade of over) lift(out.data, to, fade, pageX, pageY);
    }
  }
  return `data:image/png;base64,${tools.png.write(out).toString("base64")}`;
}

export interface Fade {
  box: { x: number; y: number; w: number; h: number };
  gradient: RawGradient;
}

/** The gradients painted above this layer: the screenshot's pixels of it already have them in. */
function fadesOver(bundle: Bundle, node: IrNode, gradients: string[]): Fade[] {
  const at = bundle.order.get(node.id) ?? 0;
  const box = node.geometry.bbox;
  const fades: Fade[] = [];
  for (const src of gradients) {
    const ir = bundle.byId.get(src);
    const gradient = ir && gradientOf(ir);
    if (!ir || !gradient || (bundle.order.get(src) ?? 0) < at) continue;
    const over = ir.geometry.bbox;
    if (
      box.x < over.x + over.w &&
      over.x < box.x + box.w &&
      box.y < over.y + over.h &&
      over.y < box.y + box.h
    ) {
      fades.push({ box: over, gradient });
    }
  }
  return fades;
}

/** A gradient's colour and cover at a point on the page. */
function fadeAt(fade: Fade, x: number, y: number) {
  const { box, gradient } = fade;
  const along = {
    90: (x - box.x) / box.w,
    270: 1 - (x - box.x) / box.w,
    180: (y - box.y) / box.h,
    0: 1 - (y - box.y) / box.h,
  }[gradient.degree];
  const t = (along ?? 0) * 100;
  const { stops } = gradient;
  let low = stops[0] as RawGradient["stops"][number];
  let high = stops[stops.length - 1] as RawGradient["stops"][number];
  for (const stop of stops) {
    if (stop.percent <= t) low = stop;
    if (stop.percent >= t) {
      high = stop;
      break;
    }
  }
  const span = high.percent - low.percent;
  const mix = span > 0 ? Math.min(1, Math.max(0, (t - low.percent) / span)) : 0;
  const [r, g, b] = channels(low.color);
  const [r2, g2, b2] = channels(high.color);
  return {
    rgb: [r + (r2 - r) * mix, g + (g2 - g) * mix, b + (b2 - b) * mix],
    cover: (low.opacity + (high.opacity - low.opacity) * mix) / 100,
  };
}

/** Takes a gradient back out of a pixel, so the gradient drawn over the crop doesn't land twice. */
export function lift(data: Buffer, at: number, fade: Fade, x: number, y: number) {
  // A gradient paints only its own box. Outside it nothing was painted over this pixel, and
  // clamping to the nearest stop would take out a colour that was never there.
  const { box } = fade;
  if (x < box.x || y < box.y || x >= box.x + box.w || y >= box.y + box.h) return;
  const { rgb, cover } = fadeAt(fade, x, y);
  // under a nearly solid fade nothing is left to recover, and nothing will show through either
  if (cover <= 0 || cover > 0.97) return;
  for (let c = 0; c < 3; c++) {
    const seen = data[at + c] ?? 0;
    data[at + c] = Math.round(
      Math.min(255, Math.max(0, (seen - (rgb[c] ?? 0) * cover) / (1 - cover))),
    );
  }
}

/** What a surface the agent adds may be called. */
const SURFACE_NAME = /^[a-z][a-z0-9_]{1,40}$/;

export interface Unpainted {
  src: string;
  name: string;
  /** What the design paints it with, as the IR says. */
  paint: string;
  /** A theme token that is that paint, when the style's own name points at exactly one. */
  token?: string;
}

/**
 * Layers whose IR says they have a fill and whose compiled node paints none.
 *
 * Needs no screenshot, which is the point: the root's own fill is in no section picture, so the
 * score has never been able to see it go missing. The compiler drops a paint it cannot bind, with
 * no note, and the frame renders without a background nobody removed.
 */
export function unpaintedLayers(bundle: Bundle, tree: Tree, themeRaw: unknown): Unpainted[] {
  const root = bundle.doc.root.geometry.bbox;
  const frameArea = Math.max(1, root.w * root.h);
  const gradients = new Set(tokensOf(themeRaw, "gradient", undefined, 1000).map((t) => t.ref));
  const out: Array<Unpainted & { area: number }> = [];
  for (const node of tree.nodes) {
    if (!["Stack", "Box", "Overlay", "Grid", "Section"].includes(node.type)) continue;
    if (node.props.surface !== undefined) continue;
    const ir = bundle.byId.get(node.src);
    const fill = ir?.fill as
      | { raw?: string; styleRef?: string; tokenRef?: string }
      | null
      | undefined;
    if (!ir || !fill || !(fill.styleRef || fill.tokenRef || fill.raw)) continue;
    if (fill.raw?.startsWith("IMAGE") || (typeof ir.opacity === "number" && ir.opacity <= 0))
      continue;
    const { w, h } = ir.geometry.bbox;
    const area = w * h;
    if (node.parent !== null && area < frameArea * 0.005) continue;
    // Figma names a gradient style `gradient/<family>/<name>` and the theme `gradient.<name>`
    const named = /^gradient\/[^/]+\/(.+)$/.exec(fill.styleRef ?? "")?.[1];
    const token = named && gradients.has(`gradient.${named}`) ? `gradient.${named}` : undefined;
    out.push({
      src: node.src,
      name: ir.name.slice(0, 40),
      paint: fill.styleRef ?? fill.tokenRef ?? fill.raw ?? "",
      ...(token ? { token } : {}),
      area,
    });
  }
  return out
    .sort((a, b) => b.area - a.area)
    .slice(0, 6)
    .map(({ area: _area, ...rest }) => rest);
}

/** The same compile a pipeline run does, with this frame's overrides, then the pipeline validator. */
export function buildFrame(tools: Toolchain, bundle: Bundle, overrides: Overrides): Built {
  const gradients = new Map<string, RawGradient>();
  const missing: string[] = [];
  for (const src of overrides.gradients) {
    const ir = bundle.byId.get(src);
    const gradient = ir && gradientOf(ir);
    if (gradient) gradients.set(gradientName(src), gradient);
    else missing.push(src);
  }
  const themeRaw = withGradients(bundle.themeRaw, gradients);
  const theme = tools.parseTheme(themeRaw);
  const compiled = tools.compile(bundle.doc, { theme, icons: overrides.icons });
  let nodes = structuredClone(compiled.tree.nodes);
  const surfaces: Built["surfaces"] = {
    assets: {},
    surfaces: Object.fromEntries(compiled.requiredSurfaces.map((s) => [s.name, s.spec])),
  };
  const cropped: string[] = [];
  const addedTexts: Built["addedTexts"] = [];
  const nodesOf = (src: string) => nodes.filter((node) => node.src === src);

  for (const src of overrides.gradients) {
    const name = gradientName(src);
    if (!gradients.has(name)) continue;
    surfaces.surfaces[name] = { layers: [{ type: "gradient", ref: `gradient.${name}` }] };
    const found = nodesOf(src);
    if (found.length === 0) missing.push(src);
    for (const node of found) node.props.surface = `surface.${name}`;
  }
  for (const src of overrides.texts) {
    const added = addText(bundle, themeRaw, nodes, src);
    if (added) addedTexts.push(added);
    else missing.push(src);
  }
  for (const src of overrides.crops) {
    const ir = bundle.byId.get(src);
    const found = nodesOf(src);
    // The compiler draws a clipped picture as the window it fills: the IR box is the whole bitmap,
    // positioned so its window shows the right part. The crop is the window, whatever the box is.
    const parent = bundle.parents.get(src);
    const window =
      parent && found.some((node) => (node.props.place as { anchor?: string })?.anchor === "fill")
        ? visibleBox(bundle, parent)
        : undefined;
    const crop = ir && cropFromPlates(tools, bundle, ir, overrides.gradients, window);
    if (!ir || !crop || found.length === 0) {
      missing.push(src);
      continue;
    }
    if (crop === "offscreen") continue;
    cropped.push(src);
    for (const node of found) {
      nodes = deleteDescendants(nodes, node.id);
      node.type = "Image";
      node.props = {
        ...(node.props.place ? { place: node.props.place } : {}),
        src: crop,
        alt: ir.name,
        fit: "fill",
        // filling its window, it takes the window's size
        ...(window
          ? {}
          : {
              size: {
                w: { raw: ir.geometry.bbox.w, _unbound: true },
                h: { raw: ir.geometry.bbox.h, _unbound: true },
              },
            }),
      };
    }
  }
  for (const src of overrides.drops) {
    const found = nodesOf(src);
    if (found.length === 0) missing.push(src);
    for (const node of found) {
      nodes = deleteDescendants(nodes, node.id).filter((other) => other.id !== node.id);
      // siblings count from 0 with no gaps
      nodes
        .filter((other) => other.parent === node.parent)
        .sort((a, b) => a.idx - b.idx)
        .forEach((other, idx) => {
          other.idx = idx;
        });
    }
  }
  for (const [name, spec] of Object.entries(overrides.surfaces)) {
    // A name the compiler never used is a NEW surface: a paint it dropped, which a layer is then
    // given through `props`. The validator checks every token in it either way.
    if (name in surfaces.surfaces || SURFACE_NAME.test(name)) surfaces.surfaces[name] = spec;
    else missing.push(`surface ${name}`);
  }
  for (const change of overrides.props) {
    const found = nodesOf(change.src);
    if (found.length === 0) missing.push(change.src);
    for (const node of found) node.props = { ...node.props, ...change.props };
  }

  const tree: Tree = { schemaVersion: compiled.tree.schemaVersion, nodes };
  const surfaceSet = tools.parseSurfaces(surfaces);
  const check = tools.validate(tree, theme, surfaceSet);
  return {
    tree,
    notes: compiled.notes,
    theme,
    themeRaw,
    surfaces,
    cropped,
    addedTexts,
    themeCss: tools.themeCss(theme, surfaceSet),
    errors: check.errors.map((e) => `${e.code} ${e.nodeId ?? ""}: ${e.message}`),
    warnings: check.warnings.length,
    missing,
  };
}

interface RawType {
  size: number;
  weight: number;
  line_height: number;
}

/**
 * Puts back a text layer the compiler dropped because no style has its exact size, weight and line
 * height. The nearest style stands in, and `exact` says whether it was one. Losing the words is
 * worse than a line height two pixels off, and the difference is reported.
 */
function addText(
  bundle: Bundle,
  themeRaw: unknown,
  nodes: TreeNode[],
  src: string,
): { src: string; style: string; exact: boolean } | undefined {
  const ir = bundle.byId.get(src);
  const parentSrc = bundle.parents.get(src);
  const parent = nodes.find((node) => node.src === parentSrc);
  const text = ir?.text as
    | {
        characters?: string;
        fontSize?: number;
        fontWeight?: number;
        lineHeight?: number;
        lines?: number;
        truncation?: string;
        autoResize?: string;
      }
    | undefined;
  if (!ir || !text?.characters || !parent || !parentSrc) return undefined;
  const body = Object.values((themeRaw as { tokens: Record<string, RawTokens> }).tokens)[0];
  const styles = Object.entries((body?.typography_desktop ?? {}) as Record<string, RawType>);
  let best: { name: string; cost: number; exact: boolean } | undefined;
  for (const [name, style] of styles) {
    const exact =
      style.size === text.fontSize &&
      style.weight === text.fontWeight &&
      style.line_height === text.lineHeight;
    const cost =
      Math.abs(style.size - (text.fontSize ?? 0)) * 100 +
      Math.abs(style.weight - (text.fontWeight ?? 0)) / 10 +
      Math.abs(style.line_height - (text.lineHeight ?? 0));
    if (!best || cost < best.cost) best = { name, cost, exact };
  }
  if (!best) return undefined;
  const ref = (ir.fill as { tokenRef?: string } | null | undefined)?.tokenRef;
  const tone = ref ? `color.${ref.replace(/\//g, "_")}` : undefined;
  const sizing = (ir.layout as { sizing?: { w?: string; h?: string } } | undefined)?.sizing ?? {};
  const box = ir.geometry.bbox;
  const axis = (mode: string | undefined, raw: number) =>
    mode === "fill" ? "full" : mode === "hug" ? "auto" : { raw, _unbound: true };
  const props: Record<string, unknown> = {
    content: text.characters,
    style: `type.${best.name}`,
    ...(tone ? { tone } : {}),
    size: { w: axis(sizing.w, box.w), h: axis(sizing.h, box.h) },
  };
  // an Overlay's children say where they sit, and a turned layer reads along its turn
  if (parent.type === "Overlay") {
    const outer = bundle.byId.get(parentSrc)?.geometry.bbox ?? box;
    props.place = {
      anchor: "top-start",
      offset: {
        block: { raw: box.y - outer.y, _unbound: true },
        inline: { raw: box.x - outer.x, _unbound: true },
      },
    };
  }
  const turn = ir.geometry.rotation;
  if (turn === 90 || turn === -90)
    props.orientation = turn === 90 ? "vertical-up" : "vertical-down";
  if (text.truncation === "ENDING" && text.lines) props.truncate = text.lines;
  if (text.autoResize === "WIDTH_AND_HEIGHT" && !props.truncate) props.wrap = false;
  const siblings = bundle.byId.get(parentSrc)?.children ?? [];
  const before = siblings.slice(
    0,
    siblings.findIndex((child) => child.id === src),
  );
  const kept = nodes.filter((node) => node.parent === parent.id);
  const at = kept.filter((node) => before.some((child) => child.id === node.src)).length;
  for (const node of kept) if (node.idx >= at) node.idx += 1;
  const taken = new Set(nodes.map((node) => node.id));
  const slug =
    ir.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "text";
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}_${n}`;
  nodes.push({ id, parent: parent.id, idx: at, type: "Text", src, props });
  return { src, style: `type.${best.name}`, exact: best.exact };
}

export interface NodeFinding {
  nodeId: string;
  src: string;
  type: string;
  /** Pixels off, at 1x, among those this node paints on top. */
  mismatch: number;
  /** Share of the node's visible pixels that are off, 0 to 100. */
  off: number;
  design: string;
  render: string;
  notes: string[];
  conform: string[];
  icon?: string;
}

export interface Measurement {
  /** Share of the pixels of the screenshots that fit that match, 0 to 100. */
  match: number;
  /** Pixels compared. Zero means nothing was measured, and match means nothing. */
  comparedPixels: number;
  /** Share of the frame's area that a compared screenshot covers, 0 to 100. */
  coverage: number;
  /** Same, for each plate. */
  plates: Array<{
    name: string;
    match: number;
    scale: number;
    placed?: "exact" | "estimated";
    problem?: string;
  }>;
  /** A screenshot was placed by search, so its numbers are close, not exact. */
  estimated: boolean;
  /** Layers on show that no compared screenshot holds: nothing has looked at these. */
  unchecked: string[];
  conformErrors: number;
  conformWarnings: number;
  totalDelta: number;
  worstDelta: number;
  placeholderIcons: number;
  findings: NodeFinding[];
  /** The same pixels by surface: one wrong surface is many small findings and one cause. */
  surfaces: SurfaceFinding[];
}

export interface SurfaceFinding {
  surface: string;
  spec: unknown;
  nodes: number;
  mismatch: number;
  /** A node using it, to read with frame.node. */
  src: string;
  design: string;
  render: string;
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** The most common colour among some pixels, to a coarse bucket. Says what paint is there. */
function dominant(image: PngImage, pixels: number[]): string {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const at of pixels) {
    const i = at * 4;
    const r = image.data[i] ?? 0;
    const g = image.data[i + 1] ?? 0;
    const b = image.data[i + 2] ?? 0;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const entry = counts.get(key) ?? { n: 0, r, g, b };
    entry.n += 1;
    counts.set(key, entry);
  }
  let best: { n: number; r: number; g: number; b: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? hex(best.r, best.g, best.b) : "none";
}

/** Lays an image on a flat grey, in place. */
export function flattenOn(image: PngImage, grey: number) {
  for (let i = 0; i < image.data.length; i += 4) {
    const cover = (image.data[i + 3] ?? 255) / 255;
    for (let c = 0; c < 3; c++) {
      image.data[i + c] = Math.round((image.data[i + c] ?? 0) * cover + grey * (1 - cover));
    }
    image.data[i + 3] = 255;
  }
}

/** A layer's Figma id and those of everything under it. */
export function subtreeOf(bundle: Bundle, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (node: IrNode | undefined) => {
    if (!node) return;
    out.add(node.id);
    for (const child of node.children ?? []) walk(child);
  };
  walk(bundle.byId.get(id));
  return out;
}

/** How far, in css pixels, to move a render so a layer's corner lands on a whole device pixel. */
export function gridNudge(at: Rect, root: Rect, scale: number): { x: number; y: number } {
  const toGrid = (offset: number) => {
    const device = offset * scale;
    // below a thousandth of a pixel it is already on the grid
    return Math.abs(device - Math.round(device)) < 1e-3 ? 0 : (Math.ceil(device) - device) / scale;
  };
  return { x: toGrid(at.x - root.x), y: toGrid(at.y - root.y) };
}

const moveRoot = (by: { x: number; y: number }) =>
  by.x === 0 && by.y === 0
    ? ""
    : `\n[data-fos-root] { position: relative; left: ${by.x}px; top: ${by.y}px; }`;

/** CSS that paints only these nodes and what is in them. Layout doesn't move. */
export function isolate(ids: string[]): string {
  const shown = ids.flatMap((id) => [`[data-fos-id="${id}"]`, `[data-fos-id="${id}"] *`]);
  return `[data-fos-root] * { visibility: hidden !important; }\n${shown.join(", ")} { visibility: visible !important; }`;
}

/** The theme's type sizes change at these page widths, and a screen is the widest band it fits. */
const TYPE_BANDS = [
  { key: "typography_desktop", viewport: 1280 },
  { key: "typography_tablet", viewport: 768 },
  { key: "typography_mobile", viewport: 375 },
] as const;

/**
 * The page width the design was drawn for. A style's size depends on the page, not the frame, so a
 * 281px card on a desktop page has desktop type. The IR's sizes say which band it is: the one whose
 * styles agree with them most, the widest on a tie.
 */
export function viewportOf(bundle: Bundle): number {
  const body = Object.values(
    (bundle.themeRaw as { tokens?: Record<string, Record<string, unknown>> }).tokens ?? {},
  )[0];
  let best: { viewport: number; agree: number } = { viewport: 1280, agree: -1 };
  for (const { key, viewport } of TYPE_BANDS) {
    const styles = (body?.[key] ?? {}) as Record<string, { size?: number }>;
    let agree = 0;
    for (const node of bundle.byId.values()) {
      const text = node.text as { styleRef?: string; fontSize?: number } | undefined;
      if (!text?.styleRef || text.fontSize === undefined) continue;
      if (styles[text.styleRef.replace(/\//g, "_")]?.size === text.fontSize) agree += 1;
    }
    if (agree > best.agree) best = { viewport, agree };
  }
  return best.viewport;
}

/**
 * Render the tree at each screenshot's own scale and compare, then blame each differing pixel on
 * the node painted on top of it. Conform says where nodes landed; only this sees paint.
 */
export async function measureFrame(
  tools: Toolchain,
  bundle: Bundle,
  built: Built,
): Promise<Measurement> {
  const root = bundle.doc.root.geometry.bbox;
  const width = Math.round(root.w);
  const height = Math.round(root.h);
  const options = (deviceScaleFactor: number) => ({
    themeCss: built.themeCss,
    fontCss: tools.fontCss,
    publicDir: tools.publicDir,
    width,
    viewport: Math.max(width, viewportOf(bundle)),
    height,
    background: PAGE,
    deviceScaleFactor,
  });
  const boxes = await tools.measureNodeBoxes(built.tree, options(1));
  const conform: Conformed = tools.conform(built.tree, bundle.doc, {
    theme: built.theme,
    boxes,
    rootSrc: bundle.doc.rootNodeId,
  });

  const byNode = new Map(built.tree.nodes.map((node) => [node.id, node]));
  // A wrapper paints nothing, so what shows through it belongs to what is under it.
  const order = paintOrder(built.tree, boxes).filter((box) => paints(byNode.get(box.id)));
  const tally = new Map<
    string,
    { off: number; seen: number; design: number[]; render: number[] }
  >();
  const colours = new Map<string, { design: string; render: string }>();
  const plates: Measurement["plates"] = [];
  const checked = new Set<string>();
  // Past the frame's edge, and on show in a preview all the same.
  const past: string[] = [];
  let totalPixels = 0;
  let totalOff = 0;
  let scaleSquared = 1;
  const covered = new Uint8Array(width * height);

  let estimated = false;
  for (const plate of measuredPlates(bundle)) {
    // flattened below, so it must not be the copy every other read shares
    const whole0 = copyOf(tools, plateImage(tools, plate.png));
    const place = placeOf(bundle, plate.nodeId, whole0);
    if (!place) {
      plates.push({
        name: plate.name,
        match: 0,
        scale: 0,
        problem: "it is not shown in the frame",
      });
      continue;
    }
    if ("problem" in place.fit) {
      plates.push({ name: plate.name, match: 0, scale: 0, problem: place.fit.problem });
      continue;
    }
    const { fit } = place;
    const { scale } = fit;
    // What a screenshot draws past the frame has no render to meet, so only the rest is compared.
    const inFrame = overlap(place.box, root);
    if (!inFrame) {
      plates.push({ name: plate.name, match: 0, scale, problem: "it draws outside the frame" });
      if (place.partial) past.push(cleanName(bundle, plate.nodeId));
      continue;
    }
    const exact = fit.extraW === undefined;
    const vis = exact ? inFrame : place.box;
    const design = exact ? cutTo(tools, whole0, place.box, inFrame, scale) : whole0;
    // A screenshot holds its layer alone, so the render is of that layer alone: everything else
    // keeps its place in the layout and paints nothing.
    const layer = subtreeOf(bundle, plate.nodeId);
    const shownNodes = built.tree.nodes.filter((node) => layer.has(node.src));
    if (shownNodes.length === 0) {
      plates.push({
        name: plate.name,
        match: 0,
        scale,
        problem: "the tree has nothing of this layer",
      });
      continue;
    }
    for (const node of shownNodes) checked.add(node.id);
    // Figma lays a screenshot out from its own corner, so everything in it sits on whole pixels.
    // The page keeps the fraction the layer has in the frame and snaps differently, a pixel off.
    // Moving the render by the fraction that puts the corner on the grid makes them comparable.
    const nudge = exact ? gridNudge(vis, root, scale) : { x: 0, y: 0 };
    const whole = tools.png.read(
      await tools.renderToPng(built.tree, {
        ...options(scale),
        themeCss: `${built.themeCss}\n${isolate(shownNodes.map((node) => node.id))}${moveRoot(nudge)}`,
      }),
    );
    flattenOn(design, PAGE_RGB);
    // Where the screenshot starts, in the frame. A screenshot with padding of unknown side is
    // placed where the render looks most like it, and said to be estimated.
    let at = { dx: 0, dy: 0 };
    let placed: "exact" | "estimated" = "exact";
    if (fit.extraW !== undefined) {
      at = bestOffset(whole, design, scale, vis, root, fit.extraW, fit.extraH);
      placed = "estimated";
    }
    const originX = vis.x - root.x + at.dx + nudge.x;
    const originY = vis.y - root.y + at.dy + nudge.y;
    const crop = cropOf(tools, whole, design, scale, originX, originY);
    const shown = design;
    const result = tools.diff(tools.png.write(crop), tools.png.write(shown), DIFF_THRESHOLD);
    const pixels = design.width * design.height;
    const matchOfPlate = round(100 - (100 * result.mismatchCount) / pixels);
    if (placed === "estimated" && matchOfPlate < MIN_ESTIMATED_MATCH) {
      plates.push({
        name: plate.name,
        match: 0,
        scale,
        problem: `${design.width}×${design.height} is larger than the layer and no placement fits it (best ${matchOfPlate}%)`,
      });
      continue;
    }
    if (placed === "estimated") {
      estimated = true;
      bundle.found ??= new Map();
      bundle.found.set(plate.nodeId, at);
    }
    scaleSquared = scale * scale;
    const mask = tools.png.read(result.diffPng);
    totalPixels += pixels;
    totalOff += result.mismatchCount;
    plates.push({ name: plate.name, scale, match: matchOfPlate, placed });
    // coverage is where the screenshot is, not where the render was moved to be compared with it
    const sitsX = originX - nudge.x;
    const sitsY = originY - nudge.y;
    for (
      let y = Math.max(0, Math.floor(sitsY));
      y < Math.min(height, Math.ceil(sitsY + design.height / scale));
      y++
    ) {
      covered.fill(
        1,
        y * width + Math.max(0, Math.floor(sitsX)),
        y * width + Math.min(width, Math.ceil(sitsX + design.width / scale)),
      );
    }

    const owners = new Int32Array(pixels).fill(-1);
    const inLayer = order.filter((box) => layer.has(byNode.get(box.id)?.src ?? ""));
    inLayer.forEach((box, index) => {
      const x0 = Math.max(0, Math.floor((box.x - originX) * scale));
      const y0 = Math.max(0, Math.floor((box.y - originY) * scale));
      const x1 = Math.min(design.width, Math.ceil((box.x + box.w - originX) * scale));
      const y1 = Math.min(design.height, Math.ceil((box.y + box.h - originY) * scale));
      for (let y = y0; y < y1; y++) {
        owners.fill(index, y * design.width + x0, y * design.width + x1);
      }
    });
    const seen = new Map<string, number[]>();
    for (let i = 0; i < pixels; i++) {
      const index = owners[i] ?? -1;
      if (index < 0) continue;
      const id = inLayer[index]?.id as string;
      const entry = tally.get(id) ?? { off: 0, seen: 0, design: [], render: [] };
      entry.seen += 1;
      tally.set(id, entry);
      const r = mask.data[i * 4] ?? 0;
      const g = mask.data[i * 4 + 1] ?? 0;
      const b = mask.data[i * 4 + 2] ?? 0;
      if (r > 50 && r > g && r > b) {
        entry.off += 1;
        const list = seen.get(id) ?? [];
        list.push(i);
        seen.set(id, list);
      }
    }
    for (const [id, list] of seen) {
      colours.set(id, { design: dominant(shown, list), render: dominant(crop, list) });
    }
  }

  const issuesOf = new Map<string, string[]>();
  const isCrop = (id: string) => byNode.get(id)?.type === "Image";
  // A crop is pinned to its layer's size on purpose, so "hardcoded size" says nothing about it.
  const errors = conform.errors.filter(
    (issue) => !(issue.code === "C3" && issue.nodeId && isCrop(issue.nodeId)),
  );
  for (const issue of errors) {
    if (!issue.nodeId) continue;
    issuesOf.set(issue.nodeId, [
      ...(issuesOf.get(issue.nodeId) ?? []),
      `${issue.code}: ${issue.message}`,
    ]);
  }
  const notesOf = new Map<string, string[]>();
  for (const note of built.notes) {
    if (!note.nodeId || note.kind === "fluid-band" || note.kind === "pinned-size") continue;
    notesOf.set(note.nodeId, [...(notesOf.get(note.nodeId) ?? []), note.message]);
  }
  const bySurface = new Map<string, SurfaceFinding & { worst: number }>();
  for (const [id, entry] of tally) {
    const node = byNode.get(id) as TreeNode;
    const name = String(node.props.surface ?? "").replace(/^surface\./, "");
    if (!name || name.startsWith("paint_")) continue;
    const mismatch = Math.round(entry.off / scaleSquared);
    const held = bySurface.get(name) ?? {
      surface: name,
      spec: built.surfaces.surfaces[name],
      nodes: 0,
      mismatch: 0,
      src: node.src,
      design: "none",
      render: "none",
      worst: -1,
    };
    held.nodes += 1;
    held.mismatch += mismatch;
    if (mismatch > held.worst) {
      held.worst = mismatch;
      held.src = node.src;
      held.design = colours.get(id)?.design ?? "none";
      held.render = colours.get(id)?.render ?? "none";
    }
    bySurface.set(name, held);
  }
  const surfaceFindings = [...bySurface.values()]
    .filter((finding) => finding.nodes > 1 && finding.mismatch >= MIN_SURFACE_MISMATCH)
    .sort((a, b) => b.mismatch - a.mismatch)
    .slice(0, MAX_SURFACES)
    .map(({ worst: _worst, ...finding }) => finding);
  const findings: NodeFinding[] = [...tally.entries()]
    .map(([id, entry]) => {
      const node = byNode.get(id) as TreeNode;
      return {
        nodeId: id,
        src: node.src,
        type: node.type,
        mismatch: Math.round(entry.off / scaleSquared),
        off: round((100 * entry.off) / Math.max(1, entry.seen)),
        design: colours.get(id)?.design ?? "none",
        render: colours.get(id)?.render ?? "none",
        notes: notesOf.get(id) ?? [],
        conform: issuesOf.get(id) ?? [],
        ...(node.type === "Icon" ? { icon: String(node.props.name) } : {}),
      };
    })
    .filter((finding) => finding.mismatch >= MIN_NODE_MISMATCH)
    .sort((a, b) => b.mismatch - a.mismatch)
    .slice(0, MAX_FINDINGS);

  return {
    match: totalPixels === 0 ? 0 : round(100 - (100 * totalOff) / totalPixels),
    comparedPixels: totalPixels,
    estimated,
    unchecked: [
      ...past,
      ...built.tree.nodes
        .filter(
          (node) =>
            !checked.has(node.id) &&
            visibleBox(bundle, node.src) &&
            paints(node) &&
            node.parent !== null,
        )
        .map((node) => cleanName(bundle, node.src, node.id)),
    ],
    coverage: round((100 * covered.reduce((sum, v) => sum + v, 0)) / (width * height)),
    plates,
    conformErrors: errors.length,
    conformWarnings: conform.warnings.length,
    totalDelta: conform.summary.geometry.totalDelta,
    worstDelta: conform.summary.geometry.worstDelta,
    // one off the frame's edge shows nowhere, so nothing is missing
    placeholderIcons: built.tree.nodes.filter(
      (node) =>
        node.type === "Icon" &&
        visibleBox(bundle, node.src) &&
        notesOf.get(node.id)?.some((n) => /no path data/.test(n)),
    ).length,
    findings,
    surfaces: surfaceFindings,
  };
}

/** Layer names hold line separators and the like, which nobody can quote back. */
const cleanName = (bundle: Bundle, id: string, fallback = id) =>
  (bundle.byId.get(id)?.name ?? fallback).replace(/\s+/g, " ").trim();

function paints(node: TreeNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== "Stack" && node.type !== "Overlay" && node.type !== "Box") return true;
  return node.props.surface !== undefined;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The part of a screenshot inside `to`, a box within the one it was placed on. */
function cutTo(tools: Toolchain, image: PngImage, from: Rect, to: Rect, scale: number): PngImage {
  if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return image;
  const left = Math.round((to.x - from.x) * scale);
  const top = Math.round((to.y - from.y) * scale);
  const w = Math.min(Math.round(to.w * scale), image.width - left);
  const h = Math.min(Math.round(to.h * scale), image.height - top);
  const out = tools.png.create(w, h);
  for (let y = 0; y < h; y++) {
    const start = ((top + y) * image.width + left) * 4;
    image.data.copy(out.data, y * w * 4, start, start + w * 4);
  }
  return out;
}

/** The part of the render a screenshot covers, on the render's own pixels. */
function cropOf(
  tools: Toolchain,
  whole: PngImage,
  design: PngImage,
  scale: number,
  originX: number,
  originY: number,
): PngImage {
  const left = Math.round(originX * scale);
  const top = Math.round(originY * scale);
  const crop = tools.png.create(design.width, design.height);
  for (let y = 0; y < design.height; y++) {
    for (let x = 0; x < design.width; x++) {
      const sx = x + left;
      const sy = y + top;
      const to = (y * design.width + x) * 4;
      const inside = sx >= 0 && sy >= 0 && sx < whole.width && sy < whole.height;
      const from = inside ? (sy * whole.width + sx) * 4 : -1;
      for (let c = 0; c < 3; c++)
        crop.data[to + c] = inside ? (whole.data[from + c] ?? 0) : PAGE_RGB;
      crop.data[to + 3] = 255;
    }
  }
  return crop;
}

/**
 * Slides a screenshot that is a few pixels bigger than its layer over the render and keeps the
 * offset where they differ least, on a sample of pixels. The padding is up to `extraW` by `extraH`
 * and falls on either side.
 */
function bestOffset(
  whole: PngImage,
  design: PngImage,
  scale: number,
  vis: Rect,
  root: Rect,
  extraW: number,
  extraH: number,
): { dx: number; dy: number } {
  const stepsW = Math.round(extraW * scale);
  const stepsH = Math.round(extraH * scale);
  const stride = 3;
  let best = { dx: 0, dy: 0, error: Number.POSITIVE_INFINITY };
  for (let ix = 0; ix <= stepsW; ix++) {
    for (let iy = 0; iy <= stepsH; iy++) {
      const dx = -ix / scale;
      const dy = -iy / scale;
      const left = Math.round((vis.x - root.x + dx) * scale);
      const top = Math.round((vis.y - root.y + dy) * scale);
      let error = 0;
      let n = 0;
      for (let y = 0; y < design.height; y += stride) {
        for (let x = 0; x < design.width; x += stride) {
          const sx = x + left;
          const sy = y + top;
          const to = (y * design.width + x) * 4;
          const inside = sx >= 0 && sy >= 0 && sx < whole.width && sy < whole.height;
          const from = (sy * whole.width + sx) * 4;
          for (let c = 0; c < 3; c++) {
            error += Math.abs(
              (design.data[to + c] ?? 0) - (inside ? (whole.data[from + c] ?? 0) : PAGE_RGB),
            );
          }
          n += 1;
        }
      }
      if (error / n < best.error) best = { dx, dy, error: error / n };
    }
  }
  return { dx: best.dx, dy: best.dy };
}

/** Boxes in the order nodes paint: a parent, then its children by `idx`. */
function paintOrder(tree: Tree, boxes: Box[]): Box[] {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const kids = new Map<string | null, TreeNode[]>();
  for (const node of tree.nodes) {
    kids.set(node.parent, [...(kids.get(node.parent) ?? []), node]);
  }
  const out: Box[] = [];
  const walk = (parent: string | null) => {
    for (const node of (kids.get(parent) ?? []).sort((a, b) => a.idx - b.idx)) {
      const box = byId.get(node.id);
      if (box) out.push(box);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

/** Layers that compiled to nothing visible because their gradient has no token. */
export function unboundGradients(bundle: Bundle, tree: Tree): string[] {
  const out: string[] = [];
  for (const node of tree.nodes) {
    const ir = bundle.byId.get(node.src);
    if (node.props.surface === undefined && ir && gradientOf(ir)) out.push(node.src);
  }
  return out;
}

/** Pictures the export has no file for: the tree has an Image with an empty `src`. */
export function missingImages(built: Built): string[] {
  return built.tree.nodes
    .filter((node) => node.type === "Image" && !node.props.src)
    .map((node) => node.src);
}

/** Icons the compiler drew as a placeholder because the export has no vectors for them. */
export function placeholderIcons(built: Built): string[] {
  const placeholders = new Set(
    built.notes.filter((note) => note.kind === "unknown-icon").map((note) => note.nodeId),
  );
  return built.tree.nodes
    .filter((node) => node.type === "Icon" && placeholders.has(node.id))
    .map((node) => node.src);
}

export interface FirstPass {
  overrides: Overrides;
  built: Built;
  measurement: Measurement;
  /** Fixes the code took back out because the frame scored worse with them. */
  undone: string[];
}

/** Leaving a fix out has to gain this much, in points of match, before it is taken out. */
const MIN_GAIN = 0.5;

/**
 * The fixes of a first pass, each kept only if the frame scores better with it. They are applied
 * together, and fixes interact: raw gradients that are right alone can be wrong over crops that
 * already hold them, and a first pass that beats the plain compile can still be ten points short
 * of what it would have scored without one fix. So each fix is left out in turn, always, and the
 * one whose absence helps most goes.
 * What comes back is never worse than the plain compile, whatever the fixes did.
 */
export async function keepWhatHelps(
  fixes: Overrides,
  start: Overrides,
  plain: number,
  score: (overrides: Overrides) => Promise<number>,
  /** What `fixes` already scored, when the caller has it: one render fewer on a big frame. */
  known?: number,
): Promise<{ overrides: Overrides; match: number; undone: string[] }> {
  const without: Record<string, (o: Overrides) => Overrides> = {
    "raw gradients": (o) => ({ ...o, gradients: start.gradients }),
    "crops from the screenshot": (o) => ({ ...o, crops: start.crops, drops: start.drops }),
    // Not text, round surfaces or alignment: words the compiler dropped come back whatever the
    // score says, and the others rarely interact with anything and cost a render each to test.
  };
  let kept = fixes;
  let match = known ?? (await score(kept));
  const undone: string[] = [];
  const left = new Set(Object.keys(without));
  while (left.size > 0) {
    let best: { name: string; overrides: Overrides; match: number } | undefined;
    for (const name of left) {
      const fix = without[name];
      if (!fix) continue;
      const variant = fix(kept);
      // a fix that was never in this pass has nothing to take out
      if (JSON.stringify(variant) === JSON.stringify(kept)) {
        left.delete(name);
        continue;
      }
      const got = await score(variant);
      if (got > match + MIN_GAIN && (!best || got > best.match)) {
        best = { name, overrides: variant, match: got };
      }
    }
    if (!best) break;
    undone.push(`${best.name}: the frame scored ${best.match}% without them and ${match}% with`);
    kept = best.overrides;
    match = best.match;
    left.delete(best.name);
  }
  // nothing a first pass did can leave the frame worse than leaving it alone
  if (match < plain - 0.05) {
    undone.push(`every fix: the plain compile scored ${plain}% and the best with fixes ${match}%`);
    return { overrides: start, match: plain, undone };
  }
  return { overrides: kept, match, undone };
}

/**
 * The fixes that need no judgement: every tokenless gradient kept raw, every placeholder icon and
 * picture the export has no file for drawn from the screenshot. Both are reported, so a reader can see what is a stand-in.
 */
export async function firstPass(
  tools: Toolchain,
  bundle: Bundle,
  start: Overrides,
  /** The plain compile's measurement, when the caller has it already. */
  plain?: Measurement,
): Promise<FirstPass> {
  const base = buildFrame(tools, bundle, start);
  // finds where screenshots with padding sit, so art can be cropped from them too
  const plainMeasured = plain ?? (await measureFrame(tools, bundle, base));
  const art = artGroups(tools, bundle, base);
  const baked = bakedArt(tools, bundle, base);
  const vectorPictures = vectorArt(tools, bundle, base);
  const parts = bundle.plates
    .filter((plate) => placeOf(bundle, plate.nodeId, plateImage(tools, plate.png))?.partial)
    .filter((plate) => base.tree.nodes.some((node) => node.src === plate.nodeId))
    .map((plate) => plate.nodeId);
  const inArt = new Set(
    [...art, ...vectorPictures, ...baked.crops, ...baked.drops, ...parts].flatMap((id) => [
      ...subtreeOf(bundle, id),
    ]),
  );
  const outside = (src: string) => !inArt.has(src);
  const texts = base.notes
    .filter((n) => n.kind === "unresolved-text-style")
    .map((n) => n.irId ?? "")
    .filter((src) => src && outside(src) && visibleBox(bundle, src));
  const overrides: Overrides = {
    ...start,
    gradients: [...start.gradients, ...unboundGradients(bundle, base.tree).filter(outside)],
    crops: [
      ...new Set([
        ...start.crops,
        ...art,
        ...vectorPictures,
        ...baked.crops,
        ...parts,
        ...placeholderIcons(base).filter(outside),
        ...missingImages(base).filter(outside),
      ]),
    ],
    drops: [...new Set([...start.drops, ...baked.drops])],
    texts: [...new Set([...start.texts, ...texts])],
    surfaces: { ...start.surfaces, ...roundSurfaces(bundle, base) },
    props: [...start.props, ...alignedTexts(tools, bundle, inArt)],
  };
  let built = buildFrame(tools, bundle, overrides);
  // A fix the validator refuses must not cost the frame its other fixes.
  let kept = overrides;
  if (built.errors.length > 0) {
    kept = { ...overrides, texts: start.texts };
    built = buildFrame(tools, bundle, kept);
  }
  if (built.errors.length > 0) {
    kept = { ...kept, surfaces: start.surfaces, props: start.props };
    built = buildFrame(tools, bundle, kept);
  }
  let measurement = await measureFrame(tools, bundle, built);
  let undone: string[] = [];
  // Crops are cut from screenshots, so a frame with none to compare against can't be checked
  if (measurement.comparedPixels > 0 && plainMeasured.comparedPixels > 0) {
    const checked = await keepWhatHelps(
      kept,
      start,
      plainMeasured.match,
      async (o) => {
        const tried = buildFrame(tools, bundle, o);
        return tried.errors.length > 0 ? -1 : (await measureFrame(tools, bundle, tried)).match;
      },
      // `measurement` is of exactly `kept`, measured a moment ago
      measurement.match,
    );
    undone = checked.undone;
    if (JSON.stringify(checked.overrides) !== JSON.stringify(kept)) {
      kept = checked.overrides;
      built = buildFrame(tools, bundle, kept);
      measurement = await measureFrame(tools, bundle, built);
    }
  }
  return { overrides: kept, built, measurement, undone };
}

/**
 * Groups drawn with masks. The IR has no masks, so the compiler stacks their raw rectangles, but
 * the export holds a picture of each group as it really looks. Mostly art, with little or no text
 * to lose: a group wrapping real content stays real.
 */
function artGroups(tools: Toolchain, bundle: Bundle, base: Built): string[] {
  const vectors = new Set(
    base.notes.filter((n) => n.kind === "decorative-vector").map((n) => n.irId),
  );
  const out: string[] = [];
  for (const plate of bundle.plates) {
    const node = bundle.byId.get(plate.nodeId);
    // IR 1.9.0 says which layers hold a mask. Such a layer's own picture is the masked result,
    // the only place the mask's effect can be seen, whatever type the layer is.
    const masked = node?.children?.some((child) => child.isMask === true) === true;
    if ((node?.type !== "GROUP" && !masked) || plate.nodeId === bundle.doc.rootNodeId) continue;
    const place = placeOf(bundle, plate.nodeId, plateImage(tools, plate.png));
    if (!place || "problem" in place.fit || place.fit.extraW !== undefined) continue;
    if (!visibleBox(bundle, plate.nodeId)) continue;
    const layer = [...subtreeOf(bundle, plate.nodeId)];
    const words = layer.filter((id) => bundle.byId.get(id)?.type === "TEXT").length;
    // without a mask to go on, a group is art only if the compiler drew it as vector stand-ins
    if (words > MAX_ART_WORDS || (!masked && !layer.some((id) => vectors.has(id)))) continue;
    if (base.tree.nodes.some((n) => n.src === plate.nodeId)) out.push(plate.nodeId);
  }
  return out;
}

/**
 * Vector art the compiler could only draw as a plain box, which has a layer picture of its own
 * (IR 1.9.0 art pictures). The picture is exactly the layer, so the crop carries nothing else.
 */
export function vectorArt(tools: Toolchain, bundle: Bundle, base: Built): string[] {
  const drawnAsBoxes = new Set(
    base.notes.filter((n) => n.kind === "decorative-vector").map((n) => n.irId),
  );
  const out: string[] = [];
  for (const plate of bundle.plates) {
    if (!plate.name.startsWith("art-vector-") || plate.nodeId === bundle.doc.rootNodeId) continue;
    if (![...subtreeOf(bundle, plate.nodeId)].some((id) => drawnAsBoxes.has(id))) continue;
    const place = placeOf(bundle, plate.nodeId, plateImage(tools, plate.png));
    if (!place || "problem" in place.fit || place.fit.extraW !== undefined) continue;
    if (base.tree.nodes.some((n) => n.src === plate.nodeId)) out.push(plate.nodeId);
  }
  return out;
}

/**
 * The same masked art when the only screenshot is of the whole card around it. The first group with
 * a picture becomes that part of the screenshot, which has everything above it baked in too, so art
 * groups inside what it covers are left out. Real layers still paint over it, so a name that lines
 * up with its baked self reads as one and a change of data shows as two.
 */
function bakedArt(tools: Toolchain, bundle: Bundle, base: Built) {
  const vectors = new Set(
    base.notes.filter((n) => n.kind === "decorative-vector").map((n) => n.irId),
  );
  const pictures = new Set(missingImages(base));
  const hasPlate = new Set(bundle.plates.map((plate) => plate.nodeId));
  const crops: string[] = [];
  const drops: string[] = [];
  for (const plate of bundle.plates) {
    const card = bundle.byId.get(plate.nodeId);
    if (!card || card.type === "GROUP" || card.type === "TEXT") continue;
    const place = placeOf(bundle, plate.nodeId, plateImage(tools, plate.png));
    if (!place || place.partial || "problem" in place.fit || place.fit.extraW !== undefined) {
      continue;
    }
    let painted: Rect | undefined;
    for (const child of card.children ?? []) {
      if (child.type !== "GROUP" || hasPlate.has(child.id)) continue;
      const seen = visibleBox(bundle, child.id);
      if (!seen || !base.tree.nodes.some((node) => node.src === child.id)) continue;
      const layer = [...subtreeOf(bundle, child.id)];
      const words = layer.filter((id) => bundle.byId.get(id)?.type === "TEXT").length;
      if (words > MAX_ART_WORDS) continue;
      const picture = layer.some((id) => pictures.has(id));
      if (!painted && picture) {
        crops.push(child.id);
        painted = seen;
      } else if (
        painted &&
        (picture || layer.some((id) => vectors.has(id))) &&
        seen.x >= painted.x &&
        seen.y >= painted.y &&
        seen.x + seen.w <= painted.x + painted.w &&
        seen.y + seen.h <= painted.y + painted.h
      ) {
        drops.push(child.id);
      }
    }
  }
  return { crops, drops };
}

/** A corner radius as big as the layer is a circle or a pill, which the theme has a token for. */
function roundSurfaces(bundle: Bundle, base: Built): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const node of base.tree.nodes) {
    const name = String(node.props.surface ?? "").replace(/^surface\./, "");
    const spec = base.surfaces.surfaces[name] as Record<string, unknown> | undefined;
    const ir = bundle.byId.get(node.src);
    const radius = (ir?.radius as { value?: number } | null | undefined)?.value;
    if (!spec || spec.radius || !ir || radius === undefined) continue;
    const { w, h } = ir.geometry.bbox;
    if (radius >= Math.min(w, h) / 2) out[name] = { ...spec, radius: "radius.rounded" };
  }
  return out;
}

/**
 * The IR doesn't record how text is aligned, but a screenshot of the text shows it: lines of
 * different widths that share a centre are centred. One line says nothing, so it is left alone.
 */
function alignedTexts(tools: Toolchain, bundle: Bundle, inArt: Set<string>): Overrides["props"] {
  const out: Overrides["props"] = [];
  const hasPlate = new Set(bundle.plates.map((plate) => plate.nodeId));
  for (const plate of bundle.plates) {
    if (bundle.byId.get(plate.nodeId)?.type !== "TEXT") continue;
    const align = alignmentOf(plateImage(tools, plate.png));
    if (align) out.push({ src: plate.nodeId, props: { align } });
  }
  // text with no screenshot of its own: its ink in the screenshot around it, by the text's colour
  for (const node of bundle.byId.values()) {
    if (node.type !== "TEXT" || hasPlate.has(node.id) || inArt.has(node.id)) continue;
    const text = node.text as { characters?: string } | undefined;
    if (!text?.characters || !/[\n\u2028\u2029]/.test(text.characters)) continue;
    if (!visibleBox(bundle, node.id)) continue;
    const ink = inkOf(tools, bundle, node);
    const align = ink && (alignmentInBox(ink) ?? alignmentOf(ink));
    // Figma's line separator is drawn as a space and a break, which moves a centred line
    const content = text.characters.replace(/[\u2028\u2029]/g, "\n");
    const props = {
      ...(align ? { align } : {}),
      ...(content !== text.characters ? { content } : {}),
    };
    if (Object.keys(props).length > 0) out.push({ src: node.id, props });
  }
  return out;
}

/** The pixels under a text layer that are the text's colour, as an image with only those opaque. */
function inkOf(tools: Toolchain, bundle: Bundle, node: IrNode): PngImage | undefined {
  const colour = tokenColour(bundle, node);
  const found = plateFor(tools, bundle, node);
  if (!colour || !found) return undefined;
  const image = plateImage(tools, found.plate.png);
  const box = node.geometry.bbox;
  const { vis, scale } = found;
  const left = Math.round((box.x - vis.x) * scale);
  const top = Math.round((box.y - vis.y) * scale);
  const w = Math.round(box.w * scale);
  const h = Math.round(box.h * scale);
  if (left < 0 || top < 0 || left + w > image.width || top + h > image.height) return undefined;
  const out = tools.png.create(w, h);
  const [r, g, b] = channels(colour);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = ((top + y) * image.width + left + x) * 4;
      const near =
        Math.abs((image.data[from] ?? 0) - r) +
          Math.abs((image.data[from + 1] ?? 0) - g) +
          Math.abs((image.data[from + 2] ?? 0) - b) <=
          INK_DISTANCE && (image.data[from + 3] ?? 0) > 128;
      out.data[(y * w + x) * 4 + 3] = near ? 255 : 0;
    }
  }
  return out;
}

/** The solid colour a layer's fill token names, if it names one. */
function tokenColour(bundle: Bundle, node: IrNode): string | undefined {
  const ref = (node.fill as { tokenRef?: string } | null | undefined)?.tokenRef;
  if (!ref) return undefined;
  const body = Object.values((bundle.themeRaw as { tokens: Record<string, RawTokens> }).tokens)[0];
  const value = body?.color?.light?.[ref.replace(/\//g, "_")];
  return typeof value === "string" && /^#[0-9a-f]{6}/i.test(value) ? value : undefined;
}

/**
 * Where ink sits in a box wider than the text, from the space it leaves on each side. Columns with
 * a stray pixel or two are art showing through, not text. Undefined if the ink fills the box.
 */
export function alignmentInBox(image: PngImage): "center" | "end" | undefined {
  // The widest run of inked columns is the text. Another run is art of the same colour, such as a
  // turned label crossing the box.
  let best: { left: number; right: number } | undefined;
  let run: { left: number; right: number } | undefined;
  for (let x = 0; x < image.width; x++) {
    let ink = 0;
    for (let y = 0; y < image.height; y++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) > 128) ink += 1;
    }
    if (ink < MIN_INK_IN_COLUMN) continue;
    if (run && x - run.right <= MAX_INK_GAP) run.right = x;
    else run = { left: x, right: x };
    if (!best || run.right - run.left > best.right - best.left) best = { ...run };
  }
  if (!best) return undefined;
  const before = best.left;
  const after = image.width - 1 - best.right;
  if (before <= ALIGN_SLACK) return undefined;
  if (Math.abs(before - after) <= ALIGN_SLACK) return "center";
  return after <= ALIGN_SLACK ? "end" : undefined;
}

/** Where the lines of text in an image line up, from what they cover on each row. */
export function alignmentOf(image: PngImage): "center" | "end" | undefined {
  const lines: Array<{ left: number; right: number }> = [];
  let line: { left: number; right: number } | undefined;
  for (let y = 0; y < image.height; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) > 128) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left < 0) {
      if (line) lines.push(line);
      line = undefined;
    } else if (line) {
      line.left = Math.min(line.left, left);
      line.right = Math.max(line.right, right);
    } else {
      line = { left, right };
    }
  }
  if (line) lines.push(line);
  if (lines.length < 2) return undefined;
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  if (spread(lines.map((l) => l.left)) <= ALIGN_SLACK) return undefined;
  if (spread(lines.map((l) => (l.left + l.right) / 2)) <= ALIGN_SLACK) return "center";
  if (spread(lines.map((l) => l.right)) <= ALIGN_SLACK) return "end";
  return undefined;
}

export const TokenKind = z.enum(["color", "space", "radius", "type", "shadow", "gradient"]);
export type TokenKind = z.infer<typeof TokenKind>;

interface RawTokens {
  spacing?: Record<string, unknown>;
  radius?: Record<string, unknown>;
  typography_desktop?: Record<string, unknown>;
  shadow?: { light?: Record<string, unknown> };
  gradient?: { light?: Record<string, unknown> };
  color?: { light?: Record<string, unknown> };
}

export interface TokenRow {
  ref: string;
  value: unknown;
}

/** The theme's tokens of one kind, as a tree refers to them; colours nearest `near` come first. */
export function tokensOf(
  themeRaw: unknown,
  kind: TokenKind,
  near?: string,
  limit = 12,
): TokenRow[] {
  const body = Object.values((themeRaw as { tokens: Record<string, RawTokens> }).tokens)[0];
  if (!body) return [];
  const list = (entries: Record<string, unknown> | undefined, ref: (name: string) => string) =>
    Object.entries(entries ?? {}).map(([name, value]) => ({ ref: ref(name), value }));
  if (kind === "space") return list(body.spacing, (n) => `space.${n.replace(/^spacing_/, "")}`);
  if (kind === "radius") return list(body.radius, (n) => `radius.${n.replace(/^radius_/, "")}`);
  if (kind === "type") return list(body.typography_desktop, (n) => `type.${n}`);
  if (kind === "shadow") return list(body.shadow?.light, (n) => `shadow.${n}`);
  if (kind === "gradient") {
    return list(body.gradient?.light, (n) => `gradient.${n.replace(/^gradient_|_gradient$/g, "")}`);
  }
  const colours = list(body.color?.light, (n) => `color.${n}`);
  if (!near) return colours.slice(0, limit);
  const [r, g, b] = channels(near);
  const distance = (row: TokenRow) => {
    if (typeof row.value !== "string" || !/^#[0-9a-f]{6}/i.test(row.value)) return Infinity;
    const [x, y, z2] = channels(row.value);
    return (x - r) ** 2 + (y - g) ** 2 + (z2 - b) ** 2;
  };
  return colours.sort((p, q) => distance(p) - distance(q)).slice(0, limit);
}
