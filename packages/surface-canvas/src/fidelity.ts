/**
 * What a screenshot of a layer cannot say, read off the Figma node (IR 1.9.0).
 *
 * Alignment, a mask, which part of a bitmap shows, and where a layer's pixels
 * really are. Each is a plain property Figma already holds; the IR just never
 * wrote it down, and every consumer downstream was guessing it back from a
 * picture instead.
 *
 * Takes structural shapes, not `SceneNode`, so the reading is testable without
 * a Figma runtime and so a node that lacks a property (an older plugin API, a
 * node type that has none) is "nothing to say", never a thrown export.
 *
 * Absence is the default throughout, the way `truncation` and `textCase` do it:
 * `LEFT`, `TOP`, "not a mask" and "no crop" are spelled by not being there.
 *
 * PURE. No Figma.
 */
import type {
  ImageInfo,
  MaskType,
  Rect,
  TextAlignHorizontal,
  TextAlignVertical,
} from "./ir/schema";

const places = (value: number, n: number): number => {
  const f = 10 ** n;
  return Math.round(value * f) / f;
};

/** How a text layer's lines sit in its box, minus the defaults. */
export function textAlignOf(node: {
  textAlignHorizontal?: unknown;
  textAlignVertical?: unknown;
}): { textAlignHorizontal?: TextAlignHorizontal; textAlignVertical?: TextAlignVertical } {
  const out: { textAlignHorizontal?: TextAlignHorizontal; textAlignVertical?: TextAlignVertical } =
    {};
  const across = node.textAlignHorizontal;
  if (across === "CENTER" || across === "RIGHT" || across === "JUSTIFIED") {
    out.textAlignHorizontal = across;
  }
  const down = node.textAlignVertical;
  if (down === "CENTER" || down === "BOTTOM") out.textAlignVertical = down;
  return out;
}

/**
 * Where a layer's pixels are: `absoluteRenderBounds`, which shadows and strokes
 * make larger than the layout box. Null for a layer that paints nothing, and for
 * a node type without one: both are "no answer", not zero.
 */
export function renderBoxOf(node: {
  absoluteRenderBounds?: { x: number; y: number; width: number; height: number } | null;
}): Rect | undefined {
  const box = node.absoluteRenderBounds;
  if (!box || !(box.width > 0) || !(box.height > 0)) return undefined;
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

/** Is this layer a mask, and of what kind. A mask clips the siblings after it. */
export function maskOf(node: {
  isMask?: unknown;
  maskType?: unknown;
}): { isMask: true; maskType?: MaskType } | undefined {
  if (node.isMask !== true) return undefined;
  const kind = node.maskType;
  return kind === "ALPHA" || kind === "VECTOR" || kind === "LUMINANCE"
    ? { isMask: true, maskType: kind }
    : { isMask: true };
}

/**
 * How a bitmap sits in its layer, beyond which `fit` it uses.
 *
 * The transform is only meaningful for a `CROP` fill (it is the window onto the
 * bitmap); for `FILL` and `FIT` Figma computes the placement itself and any
 * transform on the paint is noise, so it is not recorded.
 */
export function imageDetailOf(paint: {
  scaleMode?: string;
  imageTransform?: ReadonlyArray<ReadonlyArray<number>>;
  rotation?: number;
  scalingFactor?: number;
  opacity?: number;
}): Pick<ImageInfo, "transform" | "rotation" | "scalingFactor" | "opacity"> {
  const out: Pick<ImageInfo, "transform" | "rotation" | "scalingFactor" | "opacity"> = {};
  const t = paint.imageTransform;
  if (paint.scaleMode === "CROP" && t && t.length === 2) {
    const [r0, r1] = t;
    if (r0 && r1 && r0.length === 3 && r1.length === 3) {
      out.transform = [
        [places(r0[0]!, 5), places(r0[1]!, 5), places(r0[2]!, 5)],
        [places(r1[0]!, 5), places(r1[1]!, 5), places(r1[2]!, 5)],
      ];
    }
  }
  if (typeof paint.rotation === "number" && paint.rotation !== 0) out.rotation = paint.rotation;
  if (paint.scaleMode === "TILE" && typeof paint.scalingFactor === "number") {
    out.scalingFactor = places(paint.scalingFactor, 4);
  }
  if (typeof paint.opacity === "number" && paint.opacity !== 1) {
    out.opacity = places(paint.opacity, 3);
  }
  return out;
}
