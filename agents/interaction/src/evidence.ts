/**
 * What a published section shows about how it behaves, read from the tree, its plan, its data and
 * the design's IR. Reported as evidence: the model reads it and decides (ADR 0029, amendment: tools
 * report, the model asks). PURE.
 *
 * - `lists`: each list the plan repeats, and every part of the design's cards that differs from card
 *   to card: one card has a tick where another has an empty circle, a filled star where others have
 *   an outline, a name in bold blue, a photo each card has its own of. Each is reported with what
 *   the plan binds there and whether every card differs; nothing is left out by code. What a
 *   difference stands for (the data's, or what the fan picked) is the model's to settle.
 *   `planRules`: what the binding plan already decides about the card's layers (a `when`, a look by
 *   the item's place), so the model sees it before a behaviour makes the state decide one.
 * - `fields`: what a person can type or tick on the page (`Input`, `Checkbox`), each writing
 *   `_page.<key>`: a search box over a list, a filter.
 * - `overflow`: boxes the design clips whose content runs past them: a list in a sheet of fixed
 *   height, which scrolls.
 * - `machine`: what the section already does.
 */

import {
  childrenOf,
  type Plan,
  type PlanCollapse,
  placesIn,
  rootOf,
  type Tree,
  type TreeNode,
} from "./tree.ts";

export interface LookGroup {
  /** The look, in a few words: `type.body_sm_bold color.text_main_sec`, `Image "Star 3" #a1b2`. */
  look: string;
  /** The cards with it, 1 first. */
  cards: number[];
  /** The layer drawing it on each of those cards. */
  srcs: string[];
  /** What a picture shows, in a few words, when a vision model was asked (`ix.load` asks). */
  shows?: string;
}

export interface Difference {
  /** Where it is in a card, as child indexes from the card. */
  path: string;
  type: string;
  /** The template's layer there, when the template has one. */
  template?: string;
  /** What the plan binds on the template's layer there (`src <- photo`): the data fills it in. */
  boundTo?: string[];
  /**
   * Set when every card has a look of its own here (more than two cards): often what the data fills
   * in, such as a photo, sometimes a state each card shows differently. What is inside it is not
   * listed again.
   */
  everyCard?: string;
  groups: LookGroup[];
}

/** What the binding plan already decides about one layer of a card. */
export interface PlanRule {
  src: string;
  /** when: the plan draws the layer only when this holds. at: the layer's look by the item's place. */
  prop: "when" | "at";
  value: unknown;
}

export interface ListEvidence {
  over: string;
  as: string;
  /** The card every item draws as (the plan's first member). */
  template: string;
  cards: number;
  /** An item's fields, with a value from the data. */
  item: Record<string, string>;
  /**
   * A proposal: a field each item has its own value of (an `id`, `*_id`, `slug` or `key` first), for
   * a list in state to hold. `keys` lists every field that would do.
   */
  key?: string;
  keys?: string[];
  differences: Difference[];
  /** What the binding plan already decides about the card's layers. */
  planRules?: PlanRule[];
}

export interface FieldEvidence {
  key: string;
  type: string;
  src: string;
  placeholder?: string;
}

export interface OverflowEvidence {
  src: string;
  node: string;
  axis: "y" | "x";
  /** The box's size on that axis, and how far what is in it reaches. */
  box: number;
  content: number;
}

export interface Evidence {
  lists: ListEvidence[];
  fields: FieldEvidence[];
  overflow: OverflowEvidence[];
  /** The root's machine, when the section has one already. */
  machine?: unknown;
}

const short = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).slice(0, 6);
};

/** A layer's look, without what the data fills in (a text's words). */
export function lookOf(node: TreeNode | undefined): string {
  if (!node) return "(none)";
  const p = node.props;
  const str = (k: string) => (typeof p[k] === "string" ? String(p[k]) : undefined);
  const parts: string[] = [];
  if (node.type === "Text") {
    parts.push(str("style") ?? "", str("tone") ?? "");
  } else if (node.type === "Image") {
    parts.push(`Image "${str("alt") ?? ""}"`, str("src") ? `#${short(str("src") as string)}` : "");
  } else if (node.type === "Icon") {
    parts.push(`Icon ${str("name") ?? ""}`, str("tone") ?? "");
  } else {
    parts.push(node.type, str("surface") ?? "", str("fill") ?? "");
  }
  return parts.filter(Boolean).join(" ").trim() || node.type;
}

const sample = (v: unknown): string => {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{…}";
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

const lookup = (data: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (at, k) => (at && typeof at === "object" ? (at as Record<string, unknown>)[k] : undefined),
      data,
    );

/**
 * The parts that differ between the cards of each list the plan repeats. `placed` is each layer's
 * look by place (`at`) as the binding draws it, by src, when the caller applied the plan.
 */
export function listEvidence(
  stored: Tree,
  plan: Plan | undefined,
  data: unknown,
  placed?: Map<string, unknown>,
): ListEvidence[] {
  const kids = childrenOf(stored);
  const bySrc = new Map(stored.nodes.map((n) => [n.src, n]));
  return (plan?.collapse ?? []).flatMap((c: PlanCollapse) => {
    const cards = c.members.map((m) => bySrc.get(m)).filter((n): n is TreeNode => n !== undefined);
    const template = cards[0];
    if (!template) return [];
    const places = cards.map((card) => placesIn(card, kids));
    const paths = new Set(places.flatMap((p) => [...p.keys()]));
    const differences: Difference[] = [];
    const reported: string[] = [];
    for (const path of [...paths].sort()) {
      if (path === "") continue;
      // a part inside one already reported as present on some cards only is that part
      if (reported.some((r) => path.startsWith(`${r}/`))) continue;
      const at = places.map((p) => p.get(path));
      const byLook = new Map<string, LookGroup>();
      at.forEach((node, i) => {
        const look = lookOf(node);
        const g = byLook.get(look) ?? { look, cards: [], srcs: [] };
        g.cards.push(i + 1);
        if (node) g.srcs.push(node.src);
        byLook.set(look, g);
      });
      if (byLook.size < 2) continue;
      const groups = [...byLook.values()];
      // every card its own look: reported as such, for the model to read (a photo, or a state)
      const everyCard = groups.every((g) => g.cards.length === 1) && cards.length > 2;
      const first = at.find((n) => n !== undefined);
      const boundTo = at[0]
        ? [
            ...(c.fields ?? [])
              .filter((f) => f.src === at[0]?.src)
              .map((f) => `${f.prop} <- ${f.path ?? f.template ?? "?"}`),
            ...(plan?.bind ?? [])
              .filter((f) => f.src === at[0]?.src)
              .map((f) => `${f.prop} <- ${f.path ?? f.template ?? "?"}`),
          ]
        : [];
      differences.push({
        path,
        type: first?.type ?? "?",
        ...(at[0] ? { template: at[0].src } : {}),
        ...(boundTo.length ? { boundTo } : {}),
        ...(everyCard
          ? {
              everyCard: `each of the ${cards.length} cards has its own look here; what is inside it is not listed again`,
            }
          : {}),
        groups,
      });
      if (everyCard || groups.some((g) => g.look === "(none)")) reported.push(path);
    }
    // what the plan already decides about the template card's layers
    const inCard = new Set([...placesIn(template, kids).values()].map((n) => n.src));
    const planRules: PlanRule[] = [
      ...(plan?.set ?? [])
        .filter((r) => r.prop === "when" && inCard.has(r.src))
        .map((r) => ({ src: r.src, prop: "when" as const, value: r.value })),
      ...[...(placed ?? new Map<string, unknown>())]
        .filter(([src]) => inCard.has(src))
        .map(([src, value]) => ({ src, prop: "at" as const, value })),
    ];
    const items = lookup(data, c.over);
    const first = Array.isArray(items)
      ? (items[0] as Record<string, unknown> | undefined)
      : undefined;
    const item: Record<string, string> = {};
    for (const [k, v] of Object.entries(first ?? {})) item[k] = sample(v);
    const keys = Array.isArray(items) ? keysOf(items as Array<Record<string, unknown>>) : [];
    return [
      {
        over: c.over,
        as: c.as,
        template: template.src,
        cards: cards.length,
        item,
        ...(keys[0] ? { key: keys[0], keys } : {}),
        differences,
        ...(planRules.length ? { planRules } : {}),
      },
    ];
  });
}

/**
 * The fields every item has a value of no other item has: an `id`, `*_id`, `slug` or `key` first,
 * as a proposal. Which one a list in state holds is the model's to say.
 */
function keysOf(items: Array<Record<string, unknown>>): string[] {
  if (items.length === 0) return [];
  const fields = Object.keys(items[0] ?? {});
  const ordered = [
    ...new Set([...fields.filter((f) => /^(id|.*_id|slug|key)$/i.test(f)), ...fields]),
  ];
  return ordered.filter((f) => {
    const values = items.map((i) => i[f]);
    return (
      values.every((v) => typeof v === "string" || typeof v === "number") &&
      new Set(values).size === items.length
    );
  });
}

/** What a person can type or tick on the page. */
export function fieldEvidence(tree: Tree): FieldEvidence[] {
  return tree.nodes
    .filter((n) => (n.type === "Input" || n.type === "Checkbox") && typeof n.props.key === "string")
    .map((n) => ({
      key: String(n.props.key),
      type: n.type,
      src: n.src,
      ...(typeof n.props.placeholder === "string" ? { placeholder: n.props.placeholder } : {}),
    }));
}

interface IrBox {
  id?: string;
  clipsContent?: boolean;
  geometry?: { bbox?: { x: number; y: number; w: number; h: number } };
  children?: IrBox[];
}

/**
 * Boxes the design clips whose content runs past them by more than a few pixels, on the tree's
 * nodes. Read from the IR: a Figma frame's children keep their full size inside a frame that clips.
 * The few pixels (OVERFLOW_NOISE_PX) are a measurement floor for Figma's sub-pixel geometry and
 * strokes, not a judgement: whether a box that runs past scrolls is the model's to say.
 */
export const OVERFLOW_NOISE_PX = 4;
export function overflowEvidence(tree: Tree, ir: unknown): OverflowEvidence[] {
  const root = (ir as { root?: IrBox } | undefined)?.root ?? (ir as IrBox | undefined);
  if (!root || typeof root !== "object") return [];
  const nodeBySrc = new Map(tree.nodes.map((n) => [n.src, n]));
  const out: OverflowEvidence[] = [];
  const extent = (node: IrBox): { maxX: number; maxY: number } => {
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const child of node.children ?? []) {
      const b = child.geometry?.bbox;
      if (b) {
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
      // a child that clips stops what is inside it at its own edge
      if (!child.clipsContent) {
        const inner = extent(child);
        maxX = Math.max(maxX, inner.maxX);
        maxY = Math.max(maxY, inner.maxY);
      }
    }
    return { maxX, maxY };
  };
  const walk = (node: IrBox) => {
    const b = node.geometry?.bbox;
    if (node.clipsContent && b && node.id) {
      const { maxX, maxY } = extent(node);
      const treeNode = nodeBySrc.get(node.id);
      if (treeNode && treeNode.parent !== null) {
        if (maxY - (b.y + b.h) > OVERFLOW_NOISE_PX) {
          out.push({
            src: node.id,
            node: treeNode.id,
            axis: "y",
            box: Math.round(b.h),
            content: Math.round(maxY - b.y),
          });
        } else if (maxX - (b.x + b.w) > OVERFLOW_NOISE_PX) {
          out.push({
            src: node.id,
            node: treeNode.id,
            axis: "x",
            box: Math.round(b.w),
            content: Math.round(maxX - b.x),
          });
        }
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

export function evidenceOf(
  stored: Tree,
  plan: Plan | undefined,
  data: unknown,
  ir?: unknown,
  placed?: Map<string, unknown>,
): Evidence {
  const machine = rootOf(stored)?.props.machine;
  return {
    lists: listEvidence(stored, plan, data, placed),
    fields: fieldEvidence(stored),
    overflow: ir ? overflowEvidence(stored, ir) : [],
    ...(machine ? { machine } : {}),
  };
}
