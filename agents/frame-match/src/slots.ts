/**
 * The slots of a frame (`.scratch/page-sections/spec.md`): the parts that each show one kind of
 * data, found from the IR (`@dugout/library` `findSlots`), and what each owns in the compiled tree.
 *
 * A node of the tree belongs to the slot its `src` (a Figma layer) is in; one with no `src` of its
 * own belongs to its parent's. A layer in the background, or outside every slot, is in none. The
 * frame is still ONE tree; the slots say which nodes are whose.
 *
 * A choice (a tab bar's `_page.<key>`) belongs to the slot that draws it. When a frame has several
 * slots its key is named for the slot (`squad_women_men`), so two slots' tabs never share state.
 */

import type { OpenItem } from "@dugout/contracts";
import { findSlots, holding, type IrDoc, type IrNode } from "@dugout/library";
import { z } from "zod";
import { Content } from "./content.ts";
import type { Bundle } from "./frame.ts";
import type { Toolchain } from "./toolchain.ts";

/** A slot as found in the IR, before the tree is looked at. */
export interface FoundSlot {
  id: string;
  name: string;
  /** The IR layers it holds, top to bottom. */
  nodes: string[];
  /** Every IR layer inside them: what the tree's `src` is looked up in. */
  ir: string[];
  confidence: "sure" | "unsure";
  why?: string;
  /** The structural signature of its layers, as the section library signs one. */
  signature: string;
}

export interface FoundSlots {
  slots: FoundSlot[];
  /** Every IR layer inside the background. */
  background: string[];
}

/** Two slots a person said are one section: by their ids, the upper one first. */
export type Join = readonly [string, string];

/** What the reading says of the frame's shape: each container's kind, and the layers that are one part. */
export interface SlotShape {
  layouts: ReadonlyArray<{ src: string; kind: string }>;
  groups: ReadonlyArray<ReadonlyArray<string>>;
}

export function findFrameSlots(
  tools: Toolchain,
  bundle: Bundle,
  joins: readonly Join[] = [],
  shape?: SlotShape,
): FoundSlots {
  const doc = bundle.doc as unknown as IrDoc;
  const found = findSlots(
    doc,
    shape
      ? { layouts: shape.layouts, groups: shape.groups }
      : { layouts: tools.detectLayout(bundle.doc) },
  );
  const within = (id: string): string[] => {
    const out: string[] = [];
    const walk = (n: IrNode) => {
      out.push(n.id);
      for (const c of n.children ?? []) walk(c);
    };
    const node = bundle.byId.get(id) as unknown as IrNode | undefined;
    if (node) walk(node);
    return out;
  };
  const slots = found.bands
    .flatMap((b) => b.slots)
    .map((s): FoundSlot => {
      const layers = s.nodes.map((id) => bundle.byId.get(id) as unknown as IrNode).filter(Boolean);
      return {
        id: s.id,
        name: s.name,
        nodes: s.nodes,
        ir: s.nodes.flatMap(within),
        confidence: s.confidence,
        ...(s.why ? { why: s.why } : {}),
        signature: tools.sign && layers.length > 0 ? tools.sign(holding(layers) as never) : s.id,
      };
    });
  const sign = (ids: string[]) => {
    const layers = ids.map((id) => bundle.byId.get(id) as unknown as IrNode).filter(Boolean);
    return tools.sign && layers.length > 0 ? tools.sign(holding(layers) as never) : (ids[0] ?? "");
  };
  return { slots: joined(slots, joins, sign), background: found.background.flatMap(within) };
}

/**
 * The slots with the ones a person joined made one: their layers together, top to bottom, named
 * by the one with a heading, signed again, and sure. A join naming a slot that is not there is
 * left out (the frame changed since the answer).
 */
export function joined(
  slots: FoundSlot[],
  joins: readonly Join[],
  sign: (ids: string[]) => string,
): FoundSlot[] {
  if (joins.length === 0) return slots;
  const index = new Map(slots.map((s, i) => [s.id, i]));
  const root = slots.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : find(root[i] as number));
  for (const [a, b] of joins) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia === undefined || ib === undefined) continue;
    const [lo, hi] = [find(ia), find(ib)].sort((x, y) => x - y) as [number, number];
    if (lo !== hi) root[hi] = lo;
  }
  const groups = new Map<number, FoundSlot[]>();
  slots.forEach((s, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), s]);
  });
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0] as FoundSlot;
    const nodes = group.flatMap((s) => s.nodes);
    const named = group.find((s) => s.confidence === "sure") ?? group[0];
    return {
      id: (group[0] as FoundSlot).id,
      name: (named as FoundSlot).name,
      nodes,
      ir: group.flatMap((s) => s.ir),
      confidence: "sure" as const,
      signature: sign(nodes),
    };
  });
}

export const SPLIT_QUESTION = "section_split";
/** The candidate that keeps every part as it was found. */
export const KEEP_APART = "apart";
/** A join as a candidate's value: the ids of the two parts, joined by `+`. */
export const joinValue = ([a, b]: Join) => `${a}+${b}`;

/**
 * The parts the finder was unsure of, as joins a person may make: a heading with nothing under it
 * and the part below (proposed), or two parts with no heading between them (kept apart unless a
 * person says otherwise). Nothing when every part is sure.
 */
export function splitChoices(found: FoundSlots): { joins: Join[]; proposed: Join[] } {
  const slots = found.slots;
  const joins: Join[] = [];
  const proposed: Join[] = [];
  const add = (a: number, b: number, propose: boolean) => {
    const [x, y] = [slots[Math.min(a, b)], slots[Math.max(a, b)]];
    if (!x || !y || x === y) return;
    const pair: Join = [x.id, y.id];
    if (joins.some(([p, q]) => p === pair[0] && q === pair[1])) return;
    joins.push(pair);
    if (propose) proposed.push(pair);
  };
  slots.forEach((slot, i) => {
    if (slot.confidence !== "unsure") return;
    if (slot.why?.startsWith("a heading with no content")) {
      add(i, i + 1 < slots.length ? i + 1 : i - 1, true);
      return;
    }
    // the finder names the neighbour: "no heading between it and <id>: one section or two?"
    const neighbour = /between it and (.+?): /.exec(slot.why ?? "")?.[1];
    const other = slots.findIndex((s) => s.id === neighbour);
    if (other >= 0) add(i, other, false);
  });
  return { joins, proposed };
}

/**
 * What is open about the split (ADR 0029, 0033 amendment), as data and never as a question: the
 * parts the finder was unsure of, each join a tool can make, the finder's own proposal and what
 * memory holds. Nothing when the finder was sure. The agent's model settles it from memory, from
 * the evidence, or by asking a person in its own words, and passes the joins to `frame.split`.
 */
export function splitOpen(found: FoundSlots, before?: string): OpenItem | undefined {
  const { joins, proposed } = splitChoices(found);
  if (joins.length === 0) return undefined;
  const name = (id: string) => found.slots.find((s) => s.id === id)?.name ?? id;
  const unsure = found.slots.filter((s) => s.confidence === "unsure");
  return {
    id: SPLIT_QUESTION,
    about: "which parts of the frame are one section",
    evidence: `The frame reads as ${found.slots.length} parts (${found.slots.map((s) => `${s.name} [${s.id}]`).join(", ")}), and some are unclear: ${unsure.map((s) => `${s.name}: ${s.why ?? "unsure"}`).join("; ")}. Each section is bound to its own data, so parts joined here share one data source.`,
    candidates: [
      { value: KEEP_APART, does: "each part is its own section (joins [])" },
      ...joins.map((pair) => ({
        value: joinValue(pair),
        does: `${name(pair[0])} and ${name(pair[1])} are one section, bound together to one data source`,
      })),
    ],
    proposed: proposed.length > 0 ? proposed.map(joinValue).join(", ") : KEEP_APART,
    canTake:
      "frame.split's joins: [{ upper, lower }, ...], any pairs of the parts' ids above (the upper one first); [] keeps every part apart",
    ...(before ? { before } : {}),
  };
}

/** What a run says of one slot. */
export const SlotReport = z.object({
  id: z.string(),
  name: z.string().describe("Its heading, slugged: the-brave-squad"),
  nodes: z.array(z.string()).describe("The tree's node ids it owns"),
  content: Content,
  writes: z.array(z.string()).describe("The page keys its tabs write"),
  reads: z.array(z.string()).describe("The page keys its nodes read"),
  signature: z.string(),
  confidence: z.enum(["sure", "unsure"]),
  why: z.string().optional(),
});
export type SlotReport = z.infer<typeof SlotReport>;

interface TreeNode {
  id: string;
  parent: string | null;
  src?: string;
  type: string;
  props: Record<string, unknown>;
}

/** Which slot, by index, each node of the tree is in; -1 for none. */
export function ownersOf(nodes: TreeNode[], found: FoundSlots): Map<string, number> {
  const slotOf = new Map<string, number>();
  found.slots.forEach((s, i) => {
    for (const id of s.ir) slotOf.set(id, i);
  });
  const behind = new Set(found.background);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const owner = new Map<string, number>();
  const of = (n: TreeNode): number => {
    const known = owner.get(n.id);
    if (known !== undefined) return known;
    let at = -1;
    if (n.src !== undefined && slotOf.has(n.src)) at = slotOf.get(n.src) as number;
    else if (n.src !== undefined && behind.has(n.src)) at = -1;
    else if (n.parent !== null && byId.has(n.parent)) at = of(byId.get(n.parent) as TreeNode);
    owner.set(n.id, at);
    return at;
  };
  for (const n of nodes) of(n);
  // A node the lowering made (a carousel around one drawn slide, `synthetic:` src) is in no slot by
  // its own src: it is the slot's whose layers it holds, when they are all one slot's.
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes)
    if (n.parent !== null) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const held = (n: TreeNode): number => {
    if (!n.src?.startsWith("synthetic:") || (owner.get(n.id) ?? -1) >= 0)
      return owner.get(n.id) ?? -1;
    const under = (kids.get(n.id) ?? []).map(held).filter((i) => i >= 0);
    const at = under.length > 0 && under.every((i) => i === under[0]) ? (under[0] as number) : -1;
    owner.set(n.id, at);
    return at;
  };
  for (const n of nodes) held(n);
  return owner;
}

/** A page key made of a slot's name: `the-brave-squad` → `the_brave_squad`. */
export const keyPart = (name: string): string => {
  const part = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Za-z]/.test(part) ? part : `s_${part}`;
};

const pathKey = /^_page\.([A-Za-z_][A-Za-z0-9_]*)(\..*)?$/;

/** `value` with every `_page.<from>` path read as `_page.<to>`. */
function rekey(value: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    const m = pathKey.exec(value);
    const to = m ? renames.get(m[1] as string) : undefined;
    return to ? `_page.${to}${m?.[2] ?? ""}` : value;
  }
  if (Array.isArray(value)) return value.map((v) => rekey(v, renames));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rekey(v, renames)]));
  }
  return value;
}

/** The page keys read by `when`s in `props`: every `_page.<key>` string. */
function readsOf(value: unknown, into: Set<string>) {
  if (typeof value === "string") {
    const m = pathKey.exec(value);
    if (m) into.add(m[1] as string);
  } else if (Array.isArray(value)) for (const v of value) readsOf(v, into);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) readsOf(v, into);
}

export interface Choice {
  key: string;
  options: Array<{ value: string; label?: string; node?: string }>;
  initial: string;
  /** The slot that draws it. */
  owner?: string;
}

/**
 * The tree with each choice named for the slot that draws it (when the frame has several), the
 * choices with their owner, and for each slot the keys it writes and reads.
 *
 * `choicesOf` reads the choices a set of nodes writes (`@fanos/dsl` `pageChoices`). It is asked of
 * each slot's own nodes, so two slots that draw tabs under one key stay two choices.
 */
export function slotted<T extends TreeNode>(
  tree: { nodes: T[] },
  found: FoundSlots,
  choicesOf: (nodes: T[]) => Choice[],
): {
  tree: { nodes: T[] };
  choices: Choice[];
  owners: Map<string, number>;
  writes: string[][];
  reads: string[][];
} {
  const owners = ownersOf(tree.nodes, found);
  const several = found.slots.length > 1;
  const choices: Choice[] = [];
  const writes: string[][] = found.slots.map(() => []);
  // what each slot's keys become: its own name in front, when there are several slots
  const renames: Array<Map<string, string>> = found.slots.map(() => new Map());
  found.slots.forEach((slot, i) => {
    const mine = several ? tree.nodes.filter((n) => owners.get(n.id) === i) : tree.nodes;
    for (const c of choicesOf(mine)) {
      const key = several ? `${keyPart(slot.name)}_${c.key}` : c.key;
      renames[i]?.set(c.key, key);
      choices.push({ ...c, key, owner: slot.id });
      writes[i]?.push(key);
    }
  });
  const nodes = tree.nodes.map((n) => {
    const names = renames[owners.get(n.id) ?? -1];
    if (!names || names.size === 0 || [...names].every(([a, b]) => a === b)) return n;
    const props = rekey(n.props, names) as Record<string, unknown>;
    // a tab's own `select.key` is the bare key, not a path
    const select = props.select as { key?: unknown } | undefined;
    const key = typeof select?.key === "string" ? names.get(select.key) : undefined;
    return { ...n, props: key ? { ...props, select: { ...select, key } } : props };
  });
  const reads = found.slots.map((_, i) => {
    const keys = new Set<string>();
    for (const n of nodes) if (owners.get(n.id) === i) readsOf(n.props.when, keys);
    return [...keys];
  });
  return { tree: { ...tree, nodes }, choices, owners, writes, reads };
}
