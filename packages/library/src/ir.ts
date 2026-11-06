/**
 * The part of a Frame IR document (`@fanos/surface-canvas` `FrameIRDocument`) the library reads:
 * boxes, types, layout, and the signatures the plugin wrote. Structural typing, so a parsed
 * document is passed as it is and nothing here depends on the built `@fanos` packages.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IrNode {
  id: string;
  name: string;
  /** FRAME, GROUP, TEXT, IMAGE, VECTOR, INSTANCE, COMPONENT or OTHER. */
  type: string;
  layout?: { mode?: string; sizing?: { w?: string; h?: string } };
  geometry: {
    bbox: Rect;
    /** Where the layer's pixels are, shadows and strokes included (IR 1.9.0+). */
    renderBbox?: Rect;
  };
  structuralSignature?: string;
  /** A paint: a token's name, or a raw colour (`#rrggbb`, maybe with alpha). */
  fill?: Paint | null;
  stroke?: (Paint & { weight?: number }) | null;
  radius?: { value: number } | null;
  /** Children are cut to this layer's box. */
  clipsContent?: boolean;
  image?: unknown;
  text?: { characters?: string; fontSize?: number; lineHeight?: number | "auto" };
  children?: IrNode[];
}

export interface Paint {
  tokenRef?: string;
  raw?: string;
}

export interface IrDoc {
  rootNodeId: string;
  fileKey?: string | null;
  root: IrNode;
}

/** Every node by id, with its parent's id. */
export function indexNodes(root: IrNode): Map<string, { node: IrNode; parent: string | null }> {
  const byId = new Map<string, { node: IrNode; parent: string | null }>();
  const walk = (node: IrNode, parent: string | null) => {
    byId.set(node.id, { node, parent });
    for (const child of node.children ?? []) walk(child, node.id);
  };
  walk(root, null);
  return byId;
}

/** The box a layer's picture covers: its pixels when the IR has them, else its layout box. */
export const pictureBox = (node: IrNode): Rect => node.geometry.renderBbox ?? node.geometry.bbox;

export const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);

export function contains(outer: Rect, inner: Rect, slack = 1): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack &&
    inner.y + inner.h <= outer.y + outer.h + slack
  );
}
