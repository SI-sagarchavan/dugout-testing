/**
 * Looking at the frame: the design and the rebuild side by side, read by a vision model.
 *
 * The score counts pixels, and it is blind to whole classes of defect a person sees at once:
 * text drawn from the wrong edge moves it by a third of a point, and a missing background that no
 * screenshot holds moves it not at all. A model that can only read numbers can't find those. This
 * is the picture it was missing.
 *
 * A vision model is a separate call that returns text; the image never enters the agent's
 * transcript (`describeImage`). So a finding has to come back as something the agent can ACT on: a
 * place in the frame, and the layers under it.
 */
import { z } from "zod";
import {
  type Built,
  type Bundle,
  flattenOn,
  isolate,
  measuredPlates,
  PAGE,
  placeOf,
  plateImage,
  type Rect,
  subtreeOf,
  viewportOf,
} from "./frame.ts";
import type { Box, PngImage, Toolchain } from "./toolchain.ts";

const PAGE_RGB = 0x80;
/** The longest side the vision model reads well; past this the picture is shrunk first. */
const MAX_SIDE = 1568;
/** One pane of a pair is at most this wide, so the pair fits the side a vision model reads well. */
const PANE_PX = 780;
/** Tiles taller than this are cut again: text in a long strip shrinks past reading. */
const TILE_HEIGHT = 700;
const MAX_TILES = 12;
const GAP = 8;
/** Smaller than this and there is nothing for a vision model to read. */
const MIN_REGION_PX = 8;

export const Difference = z.object({
  kind: z.string().default("other"),
  severity: z.enum(["high", "medium", "low"]).default("medium"),
  what: z.string(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type Difference = z.infer<typeof Difference>;

/** What the vision model is asked, and how it must answer. */
export const LOOK_PROMPT = [
  "You compare two renderings of the same piece of UI. The LEFT pane is the design, and it is the",
  "truth. The RIGHT pane is a rebuild of it. Flat mid-grey (#808080) means there is nothing there,",
  "in either pane.",
  "",
  "List the differences a person would notice at a glance: an element missing or extra; a picture in",
  "the wrong place or cropped differently; text in the wrong place, aligned to the wrong edge, or of",
  "another colour, size or wording; a background, gradient or border that is missing or another",
  "colour; things overlapping that should not; content cut off.",
  "",
  "Ignore anti-aliasing, font smoothing and shifts of a pixel or two. Do not describe what matches.",
  "",
  'Reply with JSON only: {"differences":[{"kind":"missing|extra|misplaced|colour|text|clipped|',
  'overlap|other","severity":"high|medium|low","what":"one sentence naming the element","box":',
  "[x0,y0,x1,y1]}]}. The box is where the difference is in the LEFT pane, as percentages from 0 to",
  '100 of that pane\'s width and height. If the two match, reply {"differences":[]}.',
].join("\n");

/** The first JSON object in a reply, however the model dressed it. Nothing usable gives []. */
export function parseDifferences(text: string): Difference[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (json as { differences?: unknown })?.differences;
  if (!Array.isArray(list)) return [];
  const out: Difference[] = [];
  for (const item of list) {
    const parsed = Difference.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * A frame cut into tiles that each read well side by side. A pane is at most `PANE_PX` wide at the
 * scale it is shown, so a wide frame is cut into columns, and a tall one into rows: text in a
 * strip shrunk to fit one picture is not text a vision model can tell the alignment of.
 */
export function tilesOf(frame: { w: number; h: number }, max = MAX_TILES): Rect[] {
  const cols = Math.max(1, Math.ceil(frame.w / PANE_PX));
  const rows = Math.max(1, Math.min(Math.ceil(frame.h / TILE_HEIGHT), Math.floor(max / cols) || 1));
  const w = Math.ceil(frame.w / cols);
  const h = Math.ceil(frame.h / rows);
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        x: c * w,
        y: r * h,
        w: Math.min(w, frame.w - c * w),
        h: Math.min(h, frame.h - r * h),
      });
    }
  }
  return out;
}

/** Shown at 2x when a tile is narrow enough that doubling it still fits a pane, else 1x. */
export function scaleFor(tile: { w: number }): 1 | 2 {
  return tile.w * 2 <= PANE_PX * 1.25 ? 2 : 1;
}

/** A box in percent of a region, as pixels in the frame. Clamped to the region. */
export function toFrameBox(box: readonly [number, number, number, number], region: Rect): Rect {
  const pct = (v: number) => Math.min(100, Math.max(0, v)) / 100;
  const [x0, y0, x1, y1] = [pct(box[0]), pct(box[1]), pct(box[2]), pct(box[3])];
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return {
    x: Math.round(region.x + left * region.w),
    y: Math.round(region.y + top * region.h),
    w: Math.max(1, Math.round(Math.abs(x1 - x0) * region.w)),
    h: Math.max(1, Math.round(Math.abs(y1 - y0) * region.h)),
  };
}

/** The caller asked to look at a place there is nothing to look at. Not the vision call's fault. */
export class LookInputError extends Error {}

/** A region cut to the frame, so what is shown and where findings are placed are the same place. */
export function clampRegion(region: Rect, frame: { w: number; h: number }): Rect {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(frame.w, Math.ceil(region.x + region.w));
  const y1 = Math.min(frame.h, Math.ceil(region.y + region.h));
  if (x1 - x0 < MIN_REGION_PX || y1 - y0 < MIN_REGION_PX) {
    throw new LookInputError(
      `The region ${Math.round(region.w)}x${Math.round(region.h)} at ${Math.round(region.x)},${Math.round(region.y)} has less than ${MIN_REGION_PX}px of the ${frame.w}x${frame.h} frame in it. Pass a region inside the frame, or none to look at all of it.`,
    );
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface NodeAt {
  src: string;
  type: string;
  name: string;
}

/** The layers a place in the frame falls on, smallest first: where to look with frame.node. */
export function nodesAt(
  where: Rect,
  boxes: Box[],
  nodes: Array<{ id: string; src: string; type: string }>,
  nameOf: (src: string) => string,
  limit = 4,
): NodeAt[] {
  const cx = where.x + where.w / 2;
  const cy = where.y + where.h / 2;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return boxes
    .filter((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)
    .flatMap((b) => {
      const node = byId.get(b.id);
      return node?.src
        ? [{ src: node.src, type: node.type, name: nameOf(node.src).slice(0, 40) }]
        : [];
    })
    .filter((n, i, all) => all.findIndex((m) => m.src === n.src) === i)
    .slice(0, limit);
}

/** Box-filtered 2x down, or nearest 2x up. The only two a plate and a render ever need. */
function resample(tools: Toolchain, image: PngImage, factor: 0.5 | 1 | 2): PngImage {
  if (factor === 1) return image;
  if (factor === 2) {
    const out = tools.png.create(image.width * 2, image.height * 2);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        image.data.copy(
          out.data,
          (y * out.width + x) * 4,
          ((y >> 1) * image.width + (x >> 1)) * 4,
          ((y >> 1) * image.width + (x >> 1)) * 4 + 4,
        );
      }
    }
    return out;
  }
  const out = tools.png.create(Math.max(1, image.width >> 1), Math.max(1, image.height >> 1));
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          sum += image.data[(((y << 1) + dy) * image.width + (x << 1) + dx) * 4 + c] ?? 0;
        }
        out.data[(y * out.width + x) * 4 + c] = Math.round(sum / 4);
      }
    }
  }
  return out;
}

/** The design as one picture of the whole frame: its pictures laid on grey, in order. */
export function composeDesign(tools: Toolchain, bundle: Bundle, scale: 1 | 2): PngImage {
  const root = bundle.doc.root.geometry.bbox;
  const canvas = tools.png.create(Math.round(root.w * scale), Math.round(root.h * scale));
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = canvas.data[i + 1] = canvas.data[i + 2] = PAGE_RGB;
    canvas.data[i + 3] = 255;
  }
  for (const plate of measuredPlates(bundle)) {
    const raw = plateImage(tools, plate.png);
    const place = placeOf(bundle, plate.nodeId, raw);
    if (!place || "problem" in place.fit) continue;
    const found = place.fit.extraW !== undefined ? bundle.found?.get(plate.nodeId) : undefined;
    if (place.fit.extraW !== undefined && !found) continue;
    const factor = (scale / place.fit.scale) as 0.5 | 1 | 2;
    const image = resample(tools, raw, factor);
    const left = Math.round((place.box.x - root.x + (found?.dx ?? 0)) * scale);
    const top = Math.round((place.box.y - root.y + (found?.dy ?? 0)) * scale);
    for (let y = 0; y < image.height; y++) {
      const cy = top + y;
      if (cy < 0 || cy >= canvas.height) continue;
      for (let x = 0; x < image.width; x++) {
        const cx = left + x;
        if (cx < 0 || cx >= canvas.width) continue;
        const from = (y * image.width + x) * 4;
        const to = (cy * canvas.width + cx) * 4;
        const a = (image.data[from + 3] ?? 0) / 255;
        for (let c = 0; c < 3; c++) {
          canvas.data[to + c] = Math.round(
            (image.data[from + c] ?? 0) * a + (canvas.data[to + c] ?? 0) * (1 - a),
          );
        }
      }
    }
  }
  return canvas;
}

/** The rebuild as one picture of the whole frame, showing only what the design's pictures show. */
export async function renderRebuild(
  tools: Toolchain,
  bundle: Bundle,
  built: Built,
  scale: 1 | 2,
): Promise<PngImage> {
  const root = bundle.doc.root.geometry.bbox;
  const width = Math.round(root.w);
  const wholeFrame = bundle.plates.some((p) => p.nodeId === bundle.doc.rootNodeId);
  // Without a picture of the frame itself, the root's own fill is in no design picture: leave it
  // out of the rebuild too, or every pixel of it would look like a difference.
  const shown = wholeFrame
    ? ""
    : `\n${isolate(
        built.tree.nodes
          .filter((node) =>
            measuredPlates(bundle).some((p) => subtreeOf(bundle, p.nodeId).has(node.src)),
          )
          .map((node) => node.id),
      )}`;
  const png = await tools.renderToPng(built.tree, {
    themeCss: `${built.themeCss}${shown}`,
    fontCss: tools.fontCss,
    publicDir: tools.publicDir,
    width,
    viewport: Math.max(width, viewportOf(bundle)),
    height: Math.round(root.h),
    background: PAGE,
    deviceScaleFactor: scale,
  });
  const image = tools.png.read(png);
  flattenOn(image, PAGE_RGB);
  return image;
}

function cut(tools: Toolchain, image: PngImage, region: Rect, scale: number): PngImage {
  const left = Math.round(region.x * scale);
  const top = Math.round(region.y * scale);
  const w = Math.min(Math.round(region.w * scale), image.width - left);
  const h = Math.min(Math.round(region.h * scale), image.height - top);
  const out = tools.png.create(w, h);
  for (let y = 0; y < h; y++) {
    const from = ((top + y) * image.width + left) * 4;
    image.data.copy(out.data, y * w * 4, from, from + w * 4);
  }
  return out;
}

/** Area-averaged resize to a width, keeping the shape. Only ever used to shrink. */
function resizeTo(tools: Toolchain, image: PngImage, width: number): PngImage {
  if (width >= image.width) return image;
  const ratio = image.width / width;
  const height = Math.max(1, Math.round(image.height / ratio));
  const out = tools.png.create(width, height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * ratio)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * ratio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const at = (yy * image.width + xx) * 4;
          r += image.data[at] ?? 0;
          g += image.data[at + 1] ?? 0;
          b += image.data[at + 2] ?? 0;
          n += 1;
        }
      }
      const to = (y * width + x) * 4;
      out.data[to] = Math.round(r / n);
      out.data[to + 1] = Math.round(g / n);
      out.data[to + 2] = Math.round(b / n);
      out.data[to + 3] = 255;
    }
  }
  return out;
}

/** Two panes with a thin line between, shrunk just enough that the pair fits one reading. */
export function sideBySide(tools: Toolchain, left: PngImage, right: PngImage): PngImage {
  const pane = Math.min(left.width, Math.floor((MAX_SIDE - GAP) / 2));
  const a = resizeTo(tools, left, pane);
  const b = resizeTo(tools, right, pane);
  const out = tools.png.create(a.width + GAP + b.width, Math.max(a.height, b.height));
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 0;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  for (const [image, at] of [
    [a, 0],
    [b, a.width + GAP],
  ] as const) {
    for (let y = 0; y < image.height; y++) {
      const from = y * image.width * 4;
      image.data.copy(out.data, (y * out.width + at) * 4, from, from + image.width * 4);
    }
  }
  return out;
}

export interface Looked {
  bands: number;
  differences: Array<{
    where: Rect;
    kind: string;
    severity: string;
    what: string;
    layers: NodeAt[];
  }>;
}

export type See = (png: Buffer, prompt: string, signal?: AbortSignal) => Promise<string>;

/** Compares the design with the rebuild over the whole frame, or over `region` of it. */
export async function look(opts: {
  tools: Toolchain;
  bundle: Bundle;
  built: Built;
  see: See;
  region?: Rect;
  focus?: string;
  signal?: AbortSignal;
}): Promise<Looked> {
  const { tools, bundle, built, see } = opts;
  const root = bundle.doc.root.geometry.bbox;
  const frame = { w: Math.round(root.w), h: Math.round(root.h) };
  const tiles = opts.region ? [clampRegion(opts.region, frame)] : tilesOf(frame);
  const scale = scaleFor(tiles[0] ?? frame);
  const design = composeDesign(tools, bundle, scale);
  const rebuild = await renderRebuild(tools, bundle, built, scale);
  const boxes = await tools.measureNodeBoxes(built.tree, {
    themeCss: built.themeCss,
    fontCss: tools.fontCss,
    publicDir: tools.publicDir,
    width: frame.w,
    viewport: Math.max(frame.w, viewportOf(bundle)),
    height: frame.h,
    background: PAGE,
    deviceScaleFactor: 1,
  });
  const prompt = opts.focus
    ? `${LOOK_PROMPT}\n\nPay particular attention to: ${opts.focus.slice(0, 200)}`
    : LOOK_PROMPT;

  const found: Looked["differences"] = [];
  for (const band of tiles) {
    const pair = sideBySide(
      tools,
      cut(tools, design, band, scale),
      cut(tools, rebuild, band, scale),
    );
    const reply = await see(tools.png.write(pair), prompt, opts.signal);
    for (const d of parseDifferences(reply)) {
      const where = toFrameBox(d.box, band);
      found.push({
        where,
        kind: d.kind,
        severity: d.severity,
        what: d.what,
        layers: nodesAt(where, boxes, built.tree.nodes, (src) => bundle.byId.get(src)?.name ?? src),
      });
    }
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  found.sort(
    (a, b) => order[a.severity as keyof typeof order] - order[b.severity as keyof typeof order],
  );
  return { bands: tiles.length, differences: found };
}
