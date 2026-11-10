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
 * Values on the page compare as `choiceValue`s: a feed's "Women" is the toggle's `women`. An option's
 * value is made from its label by `pageValueOf`, the one rule for it.
 *
 * A LIST A CHOICE FILTERS, two ways:
 *
 *   { path: "it.category", eqPath: "_page.tab" }   one list, each item holding its option's value
 *   over: "table.{_page.view}"                     lists side by side, one per option, by key
 *
 * Either way, an option that names no value in the data shows EVERY item: an ALL tab, "Everything",
 * "Both", or a page whose key no section has set yet. For a filter, the page's value is held by no
 * item of the list (`heldBy`: the Repeater puts its list in each item's scope, `_each`), so every
 * item passes; for lists side by side, the value names no list, so every list is drawn, one after
 * another. Nothing marks such an option: what it shows follows from the data, so the same rule
 * holds for tabs drawn in another section. The cost is that an option whose items the data lacks
 * shows everything instead of nothing; a binding check reports an option no item holds.
 *
 * For lists side by side, the lists are the data's: every key under the part before the choice
 * whose value is a list (`overLists`), compared as `choiceValue`s, so the list drawn is the one the
 * page is at whichever section writes the choice, with no option list needed. A key is ONE segment
 * even with a dot in it (`seasons["2025.26"]`).
 *
 * A choice belongs to the SLOT that draws it (ADR 0032, amendment): the header with the tabs and the
 * cards under them are one slot, and only its nodes read the choice unless a read from elsewhere
 * was asked for on purpose. The page still holds every choice; with several slots in one frame,
 * a key is named for its slot (`squad_women_men`), so two slots' tabs never share state.
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
  heldBy,
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

/** The page choice a Repeater's `over` reads: `squad.{_page.squad}` reads `squad`. */
export function overChoice(over: string): string | undefined {
  return /\{_page\.([A-Za-z0-9_]+)\}/.exec(over)?.[1];
}

/** The parts of an `over` that reads a choice: `table.{_page.view}.items` → `table`, `view`, `items`. */
function overParts(over: string): { key: string; before: string; after: string } | undefined {
  const key = overChoice(over);
  if (!key) return undefined;
  const token = `{_page.${key}}`;
  const at = over.indexOf(token);
  return { key, before: over.slice(0, at).replace(/\.$/, ""), after: over.slice(at + token.length).replace(/^\./, "") };
}

/**
 * The name the data gives the option's list: the key under the part before the choice whose
 * normalised name is the option's ("Men's" and `mens` are one), else the option as written.
 */
function keyFor(names: readonly string[], value: string): string {
  const wanted = choiceValue(value);
  return names.find((k) => choiceValue(k) === wanted) ?? value;
}

/**
 * `over` for one option of the choice it reads: `squad.{_page.squad}` for `men` is `squad.men`, by
 * the key the data has (`keyFor`). `data` is the scope the Repeater is drawn in (an item's, inside
 * another Repeater). A key with a dot in it cannot be a path: read the list with `overList`.
 */
export function overFor(over: string, data: unknown, value: string): string {
  const parts = overParts(over);
  if (!parts) return over;
  const parent = parts.before ? lookup(data, parts.before) : data;
  const names = parent && typeof parent === "object" ? Object.keys(parent) : [];
  return over.replace(`{_page.${parts.key}}`, keyFor(names, value));
}

/**
 * The lists an `over` that reads a choice can draw, in the data's order: each key under the part
 * before the choice whose value (and the part after it) is a list. Keys that normalise alike are one
 * option, the first. `scope` is the scope the Repeater is drawn in.
 */
export function overLists(over: string, scope: unknown): Array<{ value: string; items: unknown[] }> {
  const parts = overParts(over);
  if (!parts) return [];
  const parent = parts.before ? lookup(scope, parts.before) : scope;
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return [];
  const seen = new Set<string>();
  const out: Array<{ value: string; items: unknown[] }> = [];
  for (const [name, value] of Object.entries(parent)) {
    if (name.startsWith("_")) continue; // the page, a Repeater's lists: never data
    const list = parts.after ? lookup(value, parts.after) : value;
    const norm = choiceValue(name);
    if (!Array.isArray(list) || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ value: name, items: list });
  }
  return out;
}

/**
 * The items an `over` that reads a choice draws while the page is at `value`: the list the value
 * names, else (an ALL option, or none chosen) every list, one after another. Undefined when the
 * data has no list there.
 */
export function overList(over: string, scope: unknown, value: string | undefined): unknown[] | undefined {
  const lists = overLists(over, scope);
  if (lists.length === 0) return undefined;
  const wanted = value === undefined ? undefined : choiceValue(value);
  const hit = lists.find((l) => choiceValue(l.value) === wanted);
  return hit ? hit.items : lists.flatMap((l) => l.items);
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
    const held = heldBy(data, dataPath);
    if (!held) {
      page.push({ path: pagePath, eq: (typeof value === "object" ? null : (value ?? null)) as Scalar });
      continue;
    }
    // a filter over the item's list: drawn while the page is at the item's value, or at a value no
    // item holds (an ALL option) — that is, while it is at none of the OTHER values the items hold
    const mine = value === undefined || value === null || typeof value === "object" ? undefined : choiceValue(value);
    const others = new Map<string, Scalar>();
    for (const h of held) {
      if (h === undefined || h === null || typeof h === "object") continue;
      const norm = choiceValue(h);
      if (norm !== mine && !others.has(norm)) others.set(norm, h as Scalar);
    }
    for (const other of others.values()) page.push({ path: pagePath, ne: other });
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
