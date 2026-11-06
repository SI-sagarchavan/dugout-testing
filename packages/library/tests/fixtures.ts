import type { IrDoc, IrNode, Rect } from "../src/index.ts";

let n = 0;

/** An IR node with what the library reads. */
export function node(
  type: string,
  box: Rect,
  opts: {
    id?: string;
    name?: string;
    mode?: "horizontal" | "vertical" | "none";
    children?: IrNode[];
    renderBbox?: Rect;
    image?: boolean;
  } = {},
): IrNode {
  n++;
  return {
    id: opts.id ?? `1:${n}`,
    name: opts.name ?? `${type === "TEXT" ? "Some words" : "Frame"} ${n}`,
    type,
    layout: { mode: opts.mode ?? "none" },
    geometry: { bbox: box, ...(opts.renderBbox ? { renderBbox: opts.renderBbox } : {}) },
    ...(opts.image ? { image: { fit: "fill" } } : {}),
    ...(type === "TEXT" ? { text: { characters: "x" } } : {}),
    children: opts.children ?? [],
  };
}

export const doc = (root: IrNode): IrDoc => ({ rootNodeId: root.id, fileKey: "file", root });

/** A card: a picture, two words and an icon, stacked. */
export function card(x: number, y: number, name = "Match Card"): IrNode {
  return node(
    "FRAME",
    { x, y, w: 300, h: 200 },
    {
      name,
      mode: "vertical",
      children: [
        node("IMAGE", { x, y, w: 300, h: 120 }),
        node("TEXT", { x, y: y + 130, w: 200, h: 20 }),
        node("TEXT", { x, y: y + 150, w: 200, h: 20 }),
        node("VECTOR", { x, y: y + 175, w: 16, h: 16 }),
      ],
    },
  );
}

/** Structure only, as the IR's signature is: type, layout mode and children, recursively. */
export function shapeOf(node: IrNode): string {
  return `${node.type}:${node.layout?.mode}(${(node.children ?? []).map(shapeOf).join(",")})`;
}
