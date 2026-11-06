/**
 * A section as another tenant sees it: its boxes, without one word, picture, crest or colour of
 * the club it came from. Drawn from the IR when the section is indexed and kept with it; painted
 * when shown, in the colours of the tenant looking at it.
 *
 * A box keeps the ROLE of its paint, not the paint: a brand-coloured band stays an accent band and
 * a card stays a surface, so the design's contrast survives in the viewer's colours. Text is bars
 * as many lines as it had; a picture is a placeholder; a small vector is an icon.
 *
 * PURE.
 */

import type { IrNode, Paint, Rect } from "./ir.ts";

export type SkeletonRole = "surface" | "accent";

export type SkeletonShape =
  | { kind: "fill"; x: number; y: number; w: number; h: number; r: number; role: SkeletonRole }
  | { kind: "outline"; x: number; y: number; w: number; h: number; r: number }
  | { kind: "image"; x: number; y: number; w: number; h: number; r: number }
  | { kind: "icon"; x: number; y: number; w: number; h: number }
  | {
      kind: "text";
      x: number;
      y: number;
      w: number;
      h: number;
      lines: number;
      /** Drawn on an accent box: in the viewer's colour for text on its accent. */
      onAccent: boolean;
    };

export interface Skeleton {
  w: number;
  h: number;
  shapes: SkeletonShape[];
}

/** The colours a skeleton is painted in: the viewing tenant's, or neutral greys. */
export interface SkeletonPalette {
  page: string;
  surface: string;
  accent: string;
  ink: string;
  onAccent: string;
  placeholder: string;
  line: string;
}

export const NEUTRAL_PALETTE: SkeletonPalette = {
  page: "#f3f4f6",
  surface: "#ffffff",
  accent: "#4b5563",
  ink: "#c7cbd1",
  onAccent: "#9ca3af",
  placeholder: "#dfe2e6",
  line: "#d1d5db",
};

/** More than this and the rest is left out: a skeleton is a sketch. */
const MAX_SHAPES = 800;
const ICON_PX = 48;
/** Brand paints, by the token's name. */
const ACCENT_TOKEN = /primary|brand|accent|secondary|\bsec\b|highlight|tertiary/i;

export function skeletonOf(section: IrNode): Skeleton {
  const origin = section.geometry.bbox;
  const shapes: SkeletonShape[] = [];
  const at = (b: Rect) => ({
    x: round(b.x - origin.x),
    y: round(b.y - origin.y),
    w: round(b.w),
    h: round(b.h),
  });

  // `clip`: what the layers around this one let show, the section's box at the least
  const walk = (node: IrNode, onAccent: boolean, clip: Rect) => {
    if (shapes.length >= MAX_SHAPES) return;
    const full = node.geometry.bbox;
    const box = intersect(full, clip);
    const r = round(node.radius?.value ?? 0);
    const hasChildren = Boolean(node.children?.length);

    if (node.type === "TEXT" || (node.text && !hasChildren)) {
      if (box) {
        const lines = Math.max(1, Math.round((linesOf(node) * box.h) / full.h));
        shapes.push({ kind: "text", ...at(box), lines, onAccent });
      }
      return;
    }
    if ((node.type === "IMAGE" || node.image) && !hasChildren) {
      if (box) shapes.push({ kind: "image", ...at(box), r });
      return;
    }
    if (node.type === "VECTOR" && full.w <= ICON_PX && full.h <= ICON_PX) {
      if (box) shapes.push({ kind: "icon", ...at(box) });
      return;
    }
    let accent = onAccent;
    if (box && node.image) {
      // a container on a picture: the picture, then what is on it
      shapes.push({ kind: "image", ...at(box), r });
    } else if (box && node.fill && node !== section) {
      const role = roleOf(node.fill);
      shapes.push({ kind: "fill", ...at(box), r, role });
      accent = role === "accent";
    } else if (box && node.stroke && (node.stroke.weight ?? 1) > 0 && node !== section) {
      shapes.push({ kind: "outline", ...at(box), r });
    }
    const inner = node.clipsContent ? intersect(full, clip) : clip;
    if (!inner) return;
    for (const child of node.children ?? []) walk(child, accent, inner);
  };

  // the section's own paint is the page the skeleton is drawn on
  const pageRole = section.fill ? roleOf(section.fill) : "surface";
  walk(section, pageRole === "accent", origin);
  if (pageRole === "accent") {
    shapes.unshift({
      kind: "fill",
      x: 0,
      y: 0,
      w: round(origin.w),
      h: round(origin.h),
      r: 0,
      role: "accent",
    });
  }
  return { w: round(origin.w), h: round(origin.h), shapes };
}

/** A paint's role: a brand token, or a raw colour saturated or dark enough to be one. */
export function roleOf(paint: Paint): SkeletonRole {
  if (paint.tokenRef) return ACCENT_TOKEN.test(paint.tokenRef) ? "accent" : "surface";
  const rgb = /^#?([0-9a-f]{6})/i.exec(paint.raw ?? "")?.[1];
  if (!rgb) return "surface";
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(rgb.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return max - min > 0.35 || luminance < 0.35 ? "accent" : "surface";
}

function linesOf(node: IrNode): number {
  const size = node.text?.fontSize ?? 16;
  const lh = node.text?.lineHeight;
  const lineHeight = typeof lh === "number" && lh > 0 ? lh : size * 1.25;
  return Math.max(1, Math.min(12, Math.round(node.geometry.bbox.h / lineHeight)));
}

const round = (v: number) => Math.round(v * 10) / 10;

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/** The skeleton as an SVG, in `palette`'s colours. */
export function skeletonSvg(
  skeleton: Skeleton,
  palette: SkeletonPalette = NEUTRAL_PALETTE,
): string {
  const parts: string[] = [];
  for (const s of skeleton.shapes) {
    switch (s.kind) {
      case "fill":
        parts.push(rect(s, s.r, palette[s.role]));
        break;
      case "outline":
        parts.push(rect(s, s.r, "none", `stroke="${palette.line}" stroke-width="1.5"`));
        break;
      case "image": {
        parts.push(rect(s, s.r, palette.placeholder));
        // a mountain and a sun, so a placeholder reads as a picture
        const m = Math.min(s.w, s.h);
        if (m >= 40) {
          const cx = s.x + s.w / 2;
          const cy = s.y + s.h / 2;
          const k = m * 0.18;
          parts.push(
            `<path d="M${n(cx - k * 1.4)} ${n(cy + k)} L${n(cx - k * 0.3)} ${n(cy - k * 0.4)} L${n(cx + k * 0.4)} ${n(cy + k * 0.4)} L${n(cx + k * 0.8)} ${n(cy)} L${n(cx + k * 1.4)} ${n(cy + k)} Z" fill="${palette.line}"/>`,
            `<circle cx="${n(cx + k * 0.7)}" cy="${n(cy - k * 0.7)}" r="${n(k * 0.3)}" fill="${palette.line}"/>`,
          );
        }
        break;
      }
      case "icon": {
        const d = Math.min(s.w, s.h);
        parts.push(
          `<rect x="${n(s.x + (s.w - d) / 2)}" y="${n(s.y + (s.h - d) / 2)}" width="${n(d)}" height="${n(d)}" rx="${n(d / 4)}" fill="${palette.line}"/>`,
        );
        break;
      }
      case "text": {
        const lineH = s.h / s.lines;
        const bar = Math.max(2, Math.min(lineH * 0.55, 14));
        const colour = s.onAccent ? palette.onAccent : palette.ink;
        for (let i = 0; i < s.lines; i++) {
          const w = i === s.lines - 1 && s.lines > 1 ? s.w * 0.6 : s.w;
          const y = s.y + i * lineH + (lineH - bar) / 2;
          parts.push(
            `<rect x="${n(s.x)}" y="${n(y)}" width="${n(Math.max(2, w))}" height="${n(bar)}" rx="${n(bar / 2)}" fill="${colour}"/>`,
          );
        }
        break;
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(skeleton.w)} ${n(skeleton.h)}" width="${n(skeleton.w)}" height="${n(skeleton.h)}">`,
    `<rect width="100%" height="100%" fill="${palette.page}"/>`,
    ...parts,
    "</svg>",
  ].join("\n");
}

function rect(
  s: { x: number; y: number; w: number; h: number },
  r: number,
  fill: string,
  extra = "",
): string {
  const rx = Math.min(r, s.w / 2, s.h / 2);
  return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"${rx > 0 ? ` rx="${n(rx)}"` : ""} fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
}

const n = (v: number) => String(Math.round(v * 10) / 10);
