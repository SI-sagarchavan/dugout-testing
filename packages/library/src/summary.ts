/**
 * A section's structure in words, from its IR: what it is made of and what repeats, never what it
 * says. "row 'Fixtures' 1440×420: 4× column 'Match Card' [image, row [icon, text, icon], 2× text]".
 *
 * The captioner reads it next to the picture, so the caption names the component and not this
 * week's match, and full-text search reads it too. Text layers' names are never used: Figma names
 * a text layer by what it says.
 *
 * PURE.
 */

import type { IrNode } from "./ir.ts";

/** Deeper than this is folded into "…". */
const MAX_DEPTH = 4;
/** A summary longer than this is cut. */
const MAX_LENGTH = 600;
/** At most this size, a vector is an icon. */
const ICON_PX = 48;
/** Figma's default layer names, which say nothing. */
const DEFAULT_NAME =
  /^(frame|group|rectangle|vector|ellipse|line|polygon|star|component|instance|image|text|auto ?layout|container|div|section|wrapper|content|layer|mask|union|subtract|boolean)\b[\s\d._-]*$/i;

export function summarize(node: IrNode): string {
  const { w, h } = node.geometry.bbox;
  const counts = new Map<string, number>();
  count(node, counts);
  const parts = ["text", "image", "icon"]
    .map((k) => [k, counts.get(k) ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
  const line = `${Math.round(w)}×${Math.round(h)}; ${parts.join(", ") || "no text or pictures"}; ${describe(node, 0)}`;
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
}

function leaf(node: IrNode): string | undefined {
  if (node.type === "TEXT" || node.text) return "text";
  // a layer with an image fill and layers on it is a container drawn on a picture
  if ((node.type === "IMAGE" || node.image) && !node.children?.length) return "image";
  if (node.type === "VECTOR") {
    const { w, h } = node.geometry.bbox;
    return w <= ICON_PX && h <= ICON_PX ? "icon" : "shape";
  }
  if (!node.children?.length) return "box";
  return undefined;
}

function count(node: IrNode, counts: Map<string, number>) {
  if (node.image && node.children?.length) counts.set("image", (counts.get("image") ?? 0) + 1);
  const kind = leaf(node);
  if (kind) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (kind !== "box") return;
  }
  for (const child of node.children ?? []) count(child, counts);
}

/** A name worth showing: a designer's, not Figma's default, short, and not on a text layer. */
export function meaningfulName(node: IrNode): string | undefined {
  if (node.type === "TEXT") return undefined;
  const name = node.name.trim();
  if (!name || name.length > 40 || DEFAULT_NAME.test(name)) return undefined;
  return name;
}

function describe(node: IrNode, depth: number): string {
  const kind = leaf(node);
  if (kind) return kind;
  const mode = node.layout?.mode;
  const shape = mode === "horizontal" ? "row" : mode === "vertical" ? "column" : "group";
  const name = meaningfulName(node);
  const backed = node.image ? " on an image" : "";
  const label = `${shape}${name ? ` '${name}'` : ""}${backed}`;
  if (depth >= MAX_DEPTH) return `${label} […]`;
  return `${label} [${collapse((node.children ?? []).map((c) => describe(c, depth + 1))).join(", ")}]`;
}

/** Runs of the same description become one, counted: "text, text, text" is "3× text". */
function collapse(items: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; ) {
    let j = i + 1;
    while (j < items.length && items[j] === items[i]) j++;
    out.push(j - i > 1 ? `${j - i}× ${items[i]}` : (items[i] as string));
    i = j;
  }
  return out;
}
