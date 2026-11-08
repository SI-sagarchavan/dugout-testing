/**
 * Page state: a choice one section makes and any section on the page reads.
 *
 * A tab bar, a toggle, a filter chip row is a set of designed nodes, each one OPTION of a choice
 * the page holds under a name (`select: { key, value }`). Pressing an option sets the key to its
 * value; while the key holds it, the option is in its `active` state and the others `inactive`,
 * so each keeps the look the design gave it (`states`). Nothing about a choice is a node type:
 * every option stays as drawn, the way a carousel's designed arrows do (`controlFor`).
 *
 * A field a person fills in writes the page the same way: an `Input` what is typed, a `Checkbox`
 * "true" or "false", each under its own `key` (`pageFields`).
 *
 * Any node of any section reads the page's choices under `_page`, in `when`:
 *
 *   { path: "_page.squad", eq: "men" }            a panel per tab
 *   { path: "item.team", eqPath: "_page.squad" }  the items of the chosen one
 *
 * Values on the page compare as `choiceValue`s: a feed's "Women" is the toggle's `women`.
 *
 * The scope is the PAGE, not the tree: the header that draws the WOMEN | MEN toggle and the strip
 * of players under it are two sections, published by two runs, and the strip reads the key the
 * header writes. So a read is never checked against the tree it is in: the key may be another
 * section's. A data source's name always starts with a lower-case letter (`fixtures`), so `_page`
 * is never one.
 *
 * The server draws each choice at its initial value (the option drawn selected, or what the host
 * says the page starts at), so the first paint is the design; the browser changes it.
 *
 * PURE.
 */

import { z } from "zod";
import {
  choiceValue,
  type Condition,
  conditionsOf,
  lookup,
  PAGE_SCOPE,
  type Predicate,
  predicateSchema,
  type Scalar,
} from "./binding.js";
import type { FlatNode, FlatTree } from "./flat.js";

export { PAGE_SCOPE };

/** A choice's key is one path segment: `_page.<key>`. */
export const PAGE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const selectSchema = z
  .object({
    key: z.string().regex(PAGE_KEY_RE, "a page key is one name: letters, digits and _"),
    value: z.string().min(1),
    initial: z.boolean().optional(),
  })
  .strict();
export type Select = z.infer<typeof selectSchema>;

/** The page state as a `when` reads it: each key's value. */
export type PageState = Record<string, string>;

export const isPagePath = (path: string): boolean => path === PAGE_SCOPE || path.startsWith(`${PAGE_SCOPE}.`);

/** The key a page path reads, `_page.squad` → `squad`. */
export const pageKeyOfPath = (path: string): string | undefined =>
  isPagePath(path) ? path.slice(PAGE_SCOPE.length + 1).split(".")[0] || undefined : undefined;

/** Does this condition read the page? */
export const readsPage = (c: Condition): boolean => isPagePath(c.path) || (c.eqPath !== undefined && isPagePath(c.eqPath));

/** A node's `select`, or undefined. */
export function selectOf(node: Pick<FlatNode, "props">): Select | undefined {
  const parsed = selectSchema.safeParse((node.props as Record<string, unknown>).select);
  return parsed.success ? parsed.data : undefined;
}

export interface PageOption {
  value: string;
  /** What the option says: its first Text's content, when it has one. */
  label?: string;
  /** The node that is the option. */
  node: string;
}

export interface PageChoice {
  key: string;
  options: PageOption[];
  /** The value the page starts at: the option marked `initial`, else the first. */
  initial: string;
}

/** The choices a tree writes, each with its options in tree order. */
export function pageChoices(tree: FlatTree): PageChoice[] {
  const kids = new Map<string, FlatNode[]>();
  for (const n of tree.nodes) {
    if (n.parent === null) continue;
    kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  }
  const labelOf = (id: string): string | undefined => {
    for (const k of [...(kids.get(id) ?? [])].sort((a, b) => a.idx - b.idx)) {
      const content = (k.props as { content?: unknown }).content;
      if (k.type === "Text" && typeof content === "string") return content;
      const inner = labelOf(k.id);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  const byKey = new Map<string, { options: PageOption[]; initial?: string }>();
  for (const node of tree.nodes) {
    const select = selectOf(node);
    if (!select) continue;
    const choice = byKey.get(select.key) ?? { options: [] };
    const label = labelOf(node.id);
    choice.options.push({ value: select.value, node: node.id, ...(label !== undefined ? { label } : {}) });
    if (select.initial && choice.initial === undefined) choice.initial = select.value;
    byKey.set(select.key, choice);
  }
  return [...byKey].map(([key, c]) => ({ key, options: c.options, initial: c.initial ?? c.options[0]?.value ?? "" }));
}

/** The node types a person fills in, each writing the page under its `key`. */
export const FIELD_TYPES = ["Input", "Checkbox"] as const;
export type PageFieldType = (typeof FIELD_TYPES)[number];

export interface PageField {
  key: string;
  type: PageFieldType;
  /** The node that is the field. */
  node: string;
  /** What the page holds for it before anyone types or ticks: the text, or "true" / "false". */
  initial: string;
}

const isField = (type: string): type is PageFieldType => (FIELD_TYPES as readonly string[]).includes(type);

/**
 * The fields a tree has, each writing `_page.<key>`: what an Input holds, whether a Checkbox is
 * ticked ("true" / "false"). A key that is not one name is left out (S17 says).
 */
export function pageFields(tree: FlatTree): PageField[] {
  const out: PageField[] = [];
  for (const node of tree.nodes) {
    if (!isField(node.type)) continue;
    const props = node.props as { key?: unknown; value?: unknown; checked?: unknown };
    if (typeof props.key !== "string" || !PAGE_KEY_RE.test(props.key)) continue;
    const initial =
      node.type === "Checkbox" ? String(props.checked === true) : typeof props.value === "string" ? props.value : "";
    out.push({ key: props.key, type: node.type, node: node.id, initial });
  }
  return out;
}

/**
 * Where each choice and field starts, over every section of a page: the first section to write a
 * key wins.
 */
export function pageDefaults(trees: FlatTree[]): PageState {
  const state: PageState = {};
  for (const tree of trees) {
    for (const c of pageChoices(tree)) state[c.key] ??= c.initial;
    for (const field of pageFields(tree)) state[field.key] ??= field.initial;
  }
  return state;
}

/** The page keys a tree reads, in `when`. */
export function pageReads(tree: FlatTree): string[] {
  const keys = new Set<string>();
  for (const node of tree.nodes) {
    const when = (node.props as { when?: unknown }).when;
    if (when === undefined) continue;
    const parsed = predicateSchema.safeParse(when);
    if (!parsed.success) continue;
    for (const c of conditionsOf(parsed.data)) {
      for (const path of [c.path, c.eqPath]) {
        const key = path === undefined ? undefined : pageKeyOfPath(path);
        if (key) keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * A `when`, split for the server: the conditions it decides from the data alone, and those that
 * read the page, made to read nothing else. A comparison of a data field with a page key becomes a
 * comparison of the key with the field's value here (`item.team` → `eq: "men"`), so the browser
 * needs only the page state to decide it. A malformed `when` is the server's (it draws; S12 says).
 */
export function splitPageWhen(when: unknown, data: unknown): { now: unknown; page: Condition[] } {
  if (when === undefined || when === null) return { now: when, page: [] };
  const parsed = predicateSchema.safeParse(when);
  if (!parsed.success) return { now: when, page: [] };
  const all = conditionsOf(parsed.data as Predicate);
  if (!all.some(readsPage)) return { now: when, page: [] };
  const now: Condition[] = [];
  const page: Condition[] = [];
  for (const c of all) {
    if (!readsPage(c)) {
      now.push(c);
      continue;
    }
    if (c.eqPath === undefined || (isPagePath(c.path) && isPagePath(c.eqPath))) {
      page.push(c);
      continue;
    }
    // one side is the page, the other is data the server already has
    const [pagePath, dataPath] = isPagePath(c.path) ? [c.path, c.eqPath] : [c.eqPath, c.path];
    const value = lookup(data, dataPath);
    page.push({ path: pagePath, eq: (typeof value === "object" ? null : (value ?? null)) as Scalar });
  }
  return { now: now.length ? now : undefined, page };
}

/** The scope a page condition is decided in. */
export const pageScope = (state: PageState): Record<string, unknown> => ({ [PAGE_SCOPE]: state });

/** A key for a choice nobody named, from its options: WOMEN | MEN → `women_men`. */
export function pageKeyOf(labels: string[]): string {
  const key = labels
    .map(pageValueOf)
    .join("_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 48);
  return PAGE_KEY_RE.test(key) ? key : `choice_${key}`;
}

/** An option's value from its label: "Men's T20" → `mens_t20`. */
export function pageValueOf(label: string): string {
  return choiceValue(label) || "option";
}
