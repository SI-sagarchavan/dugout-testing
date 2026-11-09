/**
 * One slot of a frame (`.scratch/page-sections/spec.md`): the part that shows one kind of data.
 *
 * A frame of two sections over one background is one tree with two slots (frame-match's `slots`).
 * A bind run for a slot works on that slot's nodes only: the outline, what repeats, the notes, the
 * problems and the plan are all about them. The frame stays one tree, so a slot's plan is applied
 * to the whole of it and touches the slot's nodes alone.
 *
 * A choice belongs to the slot that draws it (ADR 0032, amendment): a slot follows the ones it
 * owns, and one from elsewhere only when a designer's note or a person's answer said to.
 */

import { z } from "zod";
import type { Tree, TreeNode } from "./dsl.ts";

export const Slot = z.object({
  id: z.string().describe("The slot's id, from frame-match's slots"),
  name: z
    .string()
    .describe("Its heading, slugged: the-brave-squad. The data's name defaults to it"),
  nodes: z.array(z.string()).describe("The tree node ids the slot owns"),
  signature: z
    .string()
    .optional()
    .describe("Its structural signature: what a person's answers about it are kept under"),
  content: z
    .object({ data: z.string(), evidence: z.array(z.string()) })
    .optional()
    .describe("frame-match's read of whether the slot shows data"),
  readFrom: z
    .array(z.string())
    .default([])
    .describe(
      "Page keys of other slots' choices it reads on purpose (a designer's note or a person's answer said so)",
    ),
});
export type Slot = z.infer<typeof Slot>;

export interface Scope {
  slot: Slot;
  /** Node ids of the slot in a tree: the slot's own and everything inside them. */
  has(tree: Tree, id: string): boolean;
  /** The tree as this slot sees it: its nodes, under one root of its own. */
  view(tree: Tree): Tree;
  /** The Figma ids of the slot's nodes. */
  srcs(tree: Tree): Set<string>;
}

/** The nodes of `tree` inside the slot's, and the slot's own. */
function closure(tree: Tree, own: ReadonlySet<string>): Set<string> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const inside = new Map<string, boolean>();
  const test = (n: TreeNode): boolean => {
    const known = inside.get(n.id);
    if (known !== undefined) return known;
    const parent = n.parent === null ? undefined : byId.get(n.parent);
    const yes = own.has(n.id) || (parent !== undefined && test(parent));
    inside.set(n.id, yes);
    return yes;
  };
  return new Set(tree.nodes.filter(test).map((n) => n.id));
}

export function scopeOf(slot: Slot): Scope {
  const own = new Set(slot.nodes);
  return {
    slot,
    has: (tree, id) => closure(tree, own).has(id),
    view(tree) {
      const ids = closure(tree, own);
      const root: TreeNode = {
        id: `slot:${slot.id}`,
        parent: null,
        idx: 0,
        type: "Frame",
        src: slot.id,
        props: {},
      };
      // the slot's top nodes hang from one root of their own, in the order they had
      const nodes = tree.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => (n.parent !== null && ids.has(n.parent) ? n : { ...n, parent: root.id }));
      return { ...tree, nodes: [root, ...nodes] };
    },
    srcs(tree) {
      const ids = closure(tree, own);
      return new Set(tree.nodes.filter((n) => ids.has(n.id)).map((n) => n.src));
    },
  };
}

/** Every Figma id a plan names. */
export function plannedSrcs(plan: unknown): string[] {
  const out = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      // a `value` is a literal or a condition; its paths are not nodes
      if (k === "members") {
        for (const m of v as unknown[]) if (typeof m === "string") out.add(m);
      } else if (k === "src" && typeof v === "string") out.add(v);
      else visit(v);
    }
  };
  visit(plan);
  return [...out];
}

const PAGE_PATH = /^_page\.([A-Za-z_][A-Za-z0-9_]*)/;

/** The page keys a plan reads: every `path` or `eqPath` that starts `_page.`. */
export function pageKeysRead(plan: unknown): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if ((k === "path" || k === "eqPath") && typeof v === "string") {
        const m = PAGE_PATH.exec(v);
        if (m) keys.add(m[1] as string);
      } else visit(v);
    }
  };
  visit(plan);
  return [...keys];
}

/** What a slot says in words, for the hook search: its text and button labels, first ones first. */
export function wordsOf(view: Tree, max = 8): string[] {
  const out: string[] = [];
  for (const n of view.nodes) {
    const text =
      n.type === "Text" ? n.props.content : n.type === "Button" ? n.props.label : undefined;
    if (typeof text === "string" && text.trim() && !out.includes(text.trim()))
      out.push(text.trim());
    if (out.length >= max) break;
  }
  return out;
}
