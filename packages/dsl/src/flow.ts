/**
 * A list drawn without auto-layout: its items placed by offset in an Overlay.
 *
 * A designer who draws rows in a plain frame places each by hand, and the compiler keeps them
 * where they are: children of an Overlay, each at its own `place.offset`. Folded into a Repeater,
 * every item takes the template's offset and they all draw on top of one another. When the items
 * sit in a line at even steps, that line is what the design means: they go into a Stack along it,
 * the step between them its gap, placed where the first was, so any number of items flows.
 *
 * PURE. No filesystem, no process, no clock.
 */

import type { FlatNode, FlatTree } from "./flat.js";
import { moveNode, replaceNode, wrapIn } from "./ops.js";

/** The run, flowed: the tree, and the Stack the items are now in. */
export interface Flowed {
  tree: FlatTree;
  parentId: string;
}

/** A number a prop gives as a plain number or as `{ raw }`. */
function px(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof (value as { raw?: unknown }).raw === "number") {
    return (value as { raw: number }).raw;
  }
  return undefined;
}

interface Placed {
  node: FlatNode;
  block: number;
  inline: number;
  w: number;
  h: number;
}

/** How far off a design's hand placement may be and still be one line at one step. */
const SLACK = 1.5;

/**
 * The members of a run in an Overlay, flowed into a Stack, or why they cannot be. Undefined when
 * there is nothing to do: the parent is no Overlay, or the members are not placed by offset.
 */
export function flowPlacedRun(
  tree: FlatTree,
  parentId: string,
  memberIds: readonly string[],
): Flowed | { reason: string } | undefined {
  const parent = tree.nodes.find((n) => n.id === parentId);
  if (parent?.type !== "Overlay" || memberIds.length < 2) return undefined;
  const members = memberIds
    .map((id) => tree.nodes.find((n) => n.id === id))
    .filter((n): n is FlatNode => n !== undefined);
  const placed: Placed[] = [];
  for (const node of members) {
    const place = node.props.place as
      | { anchor?: string; offset?: { block?: unknown; inline?: unknown } }
      | undefined;
    const size = node.props.size as { w?: unknown; h?: unknown } | undefined;
    if (!place?.offset) return undefined;
    const w = px(size?.w);
    const h = px(size?.h);
    if ((place.anchor ?? "top-start") !== "top-start" || w === undefined || h === undefined) {
      return {
        reason: `the ${members.length} items are placed by hand in an Overlay (anchor ${place.anchor ?? "top-start"}, or no fixed size), so folded they draw on top of one another: not folded. Give the frame auto-layout in Figma, or bind each item by position`,
      };
    }
    placed.push({ node, block: px(place.offset.block) ?? 0, inline: px(place.offset.inline) ?? 0, w, h });
  }

  const same = (values: number[]) => Math.max(...values) - Math.min(...values) <= SLACK;
  const column = same(placed.map((p) => p.inline));
  const row = same(placed.map((p) => p.block));
  if (!column && !row) {
    return {
      reason: `the ${members.length} items are placed by hand in an Overlay, not in one line, so folded they draw on top of one another: not folded. Give the frame auto-layout in Figma, or bind each item by position`,
    };
  }
  const along = (p: Placed) => (row ? p.inline : p.block);
  const length = (p: Placed) => (row ? p.w : p.h);
  const ordered = [...placed].sort((a, b) => along(a) - along(b));
  const steps = ordered.slice(1).map((p, i) => along(p) - (along(ordered[i] as Placed) + length(ordered[i] as Placed)));
  if (steps.some((s) => s < -SLACK) || !same(steps)) {
    return {
      reason: `the ${members.length} items are placed by hand in an Overlay at uneven steps (${steps.map((s) => Math.round(s)).join(", ")} px apart), so no gap draws them: not folded. Give the frame auto-layout in Figma, or bind each item by position`,
    };
  }
  const gap = Math.max(0, Math.round((steps.reduce((a, b) => a + b, 0) / steps.length) * 2) / 2);
  const first = ordered[0] as Placed;
  const stackId = `${first.node.id}__flow`;

  let next = wrapIn(tree, first.node.id, "Stack", {
    direction: row ? "row" : "column",
    gap: { raw: gap, _unbound: true },
    align: "start",
    place: {
      anchor: "top-start",
      offset: {
        block: { raw: Math.min(...placed.map((p) => p.block)), _unbound: true },
        inline: { raw: Math.min(...placed.map((p) => p.inline)), _unbound: true },
      },
    },
  }, stackId);
  ordered.forEach((p, i) => {
    if (i > 0) next = moveNode(next, p.node.id, stackId, i);
    const { place: _place, ...rest } = p.node.props;
    next = replaceNode(next, p.node.id, { type: p.node.type, props: rest });
  });
  return { tree: next, parentId: stackId };
}
