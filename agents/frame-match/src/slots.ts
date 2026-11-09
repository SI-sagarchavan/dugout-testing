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

export function findFrameSlots(tools: Toolchain, bundle: Bundle): FoundSlots {
  const doc = bundle.doc as unknown as IrDoc;
  const found = findSlots(doc, { layouts: tools.detectLayout(bundle.doc) });
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
  return { slots, background: found.background.flatMap(within) };
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
