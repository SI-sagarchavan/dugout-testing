/**
 * The facts a binder needs, from the frame and the data alone. Deterministic, and about no API in
 * particular: nothing here knows what a match, an article or a score is. The same frame and the
 * same sample always give the same facts. They report what is there; what it means (which order
 * a list wants, whether data is the design's, what kind of value a placeholder is) is the model's
 * to read from them.
 *
 * - `outline`: the compiled tree as a person would skim it, with what repeats and what is a variant
 *   of one component marked from the Figma structure, not from exact sizes (two instances of one
 *   card differ by their text widths and repairs, and are still one card).
 * - `shapeOf`: the data's paths, types, how often each is present, and the values of the few-valued
 *   ones (the fields a variant can be chosen by).
 * - `dryRun`: a plan applied and drawn against every item of the sample, without a browser: what
 *   would not resolve, and which item draws no variant or two.
 */

import { type About, formOf, hasForm } from "@dugout/agent-hook-maker";

export { type About, formOf, hasForm };

import type { Dsl, IrNode, Tree, TreeNode } from "./dsl.ts";

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

const PICTURE = new Set(["Image", "Icon"]);
const CONTENT = new Set(["Text", "Image", "Icon", "Button", "Link", "Tag"]);

function childrenOf(tree: Tree): Map<string, TreeNode[]> {
  const kids = new Map<string, TreeNode[]>();
  for (const node of tree.nodes) {
    if (node.parent === null) continue;
    kids.set(node.parent, [...(kids.get(node.parent) ?? []), node]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);
  return kids;
}

/**
 * What a node is made of, by kind only: sizes, copy, tokens and repairs left out, and a picture is a
 * picture whether it compiled to an Icon or a cropped Image. Two siblings with one skeleton are one
 * thing drawn twice.
 */
export function skeletons(tree: Tree): Map<string, string> {
  const kids = childrenOf(tree);
  const out = new Map<string, string>();
  const of = (node: TreeNode): string => {
    const known = out.get(node.id);
    if (known !== undefined) return known;
    const kind = PICTURE.has(node.type) ? "P" : node.type;
    const inner = (kids.get(node.id) ?? []).map(of);
    const sk = inner.length ? `${kind}(${inner.join(",")})` : kind;
    out.set(node.id, sk);
    return sk;
  };
  for (const node of tree.nodes) of(node);
  return out;
}

export interface Group {
  parent: string;
  /** Figma ids of the members, in order. */
  members: string[];
  /** One skeleton: a plain repeat. Several: variants of one component (`shape: "varies"`). */
  shapes: string[][];
  component?: string;
  /** A carousel that draws only its slide on show: the one member is repeated for every item. */
  oneSlide?: boolean;
}

/**
 * Siblings that are one thing repeated: either the same skeleton, or instances of the same Figma
 * component (its name), whose variants may differ in shape. A pair is enough: a design draws two
 * cards to show a list as often as six.
 */
export function groups(tree: Tree, byId: Map<string, IrNode>): Group[] {
  const kids = childrenOf(tree);
  const sk = skeletons(tree);
  const out: Group[] = [];
  // Document order, so a group is found before the groups inside its members.
  const order = new Map(walkOrder(tree, kids).map((id, i) => [id, i]));
  const parents = [...kids.entries()].sort(
    (a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0),
  );
  /** Inside a member that a list removes (every member but the first): repeats there go with it. */
  const removed = new Set<string>();
  const remove = (ids: TreeNode[]) => {
    for (const node of ids.slice(1)) for (const id of subtree(node.id, kids)) removed.add(id);
  };
  for (const [parent, list] of parents) {
    if (removed.has(parent)) continue;
    const parentNode = tree.nodes.find((n) => n.id === parent);
    const parentSrc = parentNode?.src ?? parent;
    // a carousel that draws only its slide on show: that slide is a list of one, repeated per item
    const only = list.length === 1 ? list[0] : undefined;
    if (parentNode?.type === "Carousel" && only && hasContent(only, kids)) {
      out.push({ parent: parentSrc, members: [only.src], shapes: [[only.src]], oneSlide: true });
      continue;
    }
    // instances of one component, by its name
    const byComponent = new Map<string, TreeNode[]>();
    for (const node of list) {
      const ir = byId.get(node.src);
      if (ir?.type !== "INSTANCE") continue;
      byComponent.set(ir.name, [...(byComponent.get(ir.name) ?? []), node]);
    }
    const claimed = new Set<string>();
    for (const [name, members] of byComponent) {
      if (members.length < 2) continue;
      for (const m of members) claimed.add(m.id);
      remove(members);
      out.push({
        parent: parentSrc,
        members: members.map((m) => m.src),
        shapes: shapesOf(members, sk),
        component: name,
      });
    }
    // the same skeleton, more than once, among what is left
    const bySkeleton = new Map<string, TreeNode[]>();
    for (const node of list) {
      if (claimed.has(node.id) || !hasContent(node, kids)) continue;
      const key = sk.get(node.id) ?? "";
      bySkeleton.set(key, [...(bySkeleton.get(key) ?? []), node]);
    }
    for (const members of bySkeleton.values()) {
      if (members.length < 2) continue;
      // Two lone texts side by side are two things (a value and its unit), not a list of one;
      // three or more of the same leaf can be (a row of tags).
      const first = members[0];
      if (first && CONTENT.has(first.type) && members.length < 3) continue;
      remove(members);
      out.push({
        parent: parentSrc,
        members: members.map((m) => m.src),
        shapes: [members.map((m) => m.src)],
      });
    }
  }
  return out;
}

function walkOrder(tree: Tree, kids: Map<string, TreeNode[]>): string[] {
  const root = tree.nodes.find((n) => n.parent === null);
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const child of kids.get(id) ?? []) walk(child.id);
  };
  if (root) walk(root.id);
  return out;
}

function subtree(id: string, kids: Map<string, TreeNode[]>): string[] {
  const out = [id];
  for (const child of kids.get(id) ?? []) out.push(...subtree(child.id, kids));
  return out;
}

function shapesOf(members: TreeNode[], sk: Map<string, string>): string[][] {
  const by = new Map<string, string[]>();
  for (const m of members) {
    const key = sk.get(m.id) ?? "";
    by.set(key, [...(by.get(key) ?? []), m.src]);
  }
  return [...by.values()];
}

function hasContent(node: TreeNode, kids: Map<string, TreeNode[]>): boolean {
  if (CONTENT.has(node.type)) return true;
  return (kids.get(node.id) ?? []).some((k) => hasContent(k, kids));
}

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The tree as lines a model can skim: containers that hold content, and the content itself with
 * what the design shows in it. A sibling with the same skeleton as one already shown is one line.
 * Every line starts with the Figma id a plan names it by.
 */
export function outline(tree: Tree, byId: Map<string, IrNode>, maxLines = 400): string[] {
  const kids = childrenOf(tree);
  const sk = skeletons(tree);
  const root = tree.nodes.find((n) => n.parent === null);
  if (!root) return [];
  const lines: string[] = [];
  const walk = (node: TreeNode, depth: number) => {
    if (lines.length >= maxLines) return;
    if (!hasContent(node, kids)) return;
    const pad = "  ".repeat(depth);
    const ir = byId.get(node.src);
    const component =
      ir?.type === "INSTANCE"
        ? ` «${ir.name}»${ir.componentKey ? ` variant ${ir.componentKey.slice(0, 6)}` : ""}`
        : "";
    lines.push(`${pad}${node.src} ${node.type}${component}${describe(node)}`);
    const seen = new Map<string, string>();
    for (const child of kids.get(node.id) ?? []) {
      if (!hasContent(child, kids)) continue;
      const key = sk.get(child.id) ?? "";
      const first = seen.get(key);
      if (first !== undefined && !CONTENT.has(child.type)) {
        lines.push(`${pad}  ${child.src} ${child.type} — same shape as ${first}`);
        continue;
      }
      seen.set(key, child.src);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  if (lines.length >= maxLines) lines.push(`… cut at ${maxLines} lines`);
  return lines;
}

function describe(node: TreeNode): string {
  const p = node.props;
  switch (node.type) {
    case "Text":
      return ` "${clip(String(p.content ?? ""))}"${p.textCase ? ` (shown ${p.textCase}case)` : ""}`;
    case "Image":
      return ` [picture${p.alt ? ` "${clip(String(p.alt), 30)}"` : ""}]`;
    case "Icon":
      return ` [glyph ${String(p.name ?? "")}]`;
    case "Button":
      return ` [button "${clip(String(p.label ?? ""))}"]`;
    case "Carousel":
      return " [carousel: each child is a slide]";
    case "Repeater":
      return ` [repeats over ${String(p.over)} as ${String(p.as)}]`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

interface Field {
  /** Values seen, null and "" included. */
  seen: number;
  /** Values that are there: not missing, null, "" or []. */
  present: number;
  types: Set<string>;
  values: Map<string, number>;
  lengths: number[];
}

const present = (v: unknown) =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Every path in the data, `[]` standing for "each item of this list". Paths inside a list are
 * written from the list, so `fixtures.items[].matches[].state` is `day.matches[].state` once the
 * days are a repeat with `as: "day"`.
 */
export function shapeOf(data: unknown, maxLines = 150): string[] {
  const fields = new Map<string, Field>();
  const field = (path: string) => {
    let f = fields.get(path);
    if (!f) {
      f = { seen: 0, present: 0, types: new Set(), values: new Map(), lengths: [] };
      fields.set(path, f);
    }
    return f;
  };
  const visit = (value: unknown, path: string) => {
    if (path) {
      const f = field(path);
      f.seen += 1;
      if (present(value)) f.present += 1;
      f.types.add(value === null ? "null" : Array.isArray(value) ? "list" : typeof value);
      if (Array.isArray(value)) f.lengths.push(value.length);
      else if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        const key = typeof value === "string" ? value : String(value);
        f.values.set(key, (f.values.get(key) ?? 0) + 1);
      }
    }
    if (Array.isArray(value)) for (const item of value) visit(item, `${path}[]`);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(data, "");
  const lines: string[] = [];
  for (const [path, f] of fields) {
    if (lines.length >= maxLines) {
      lines.push(`… cut at ${maxLines} paths`);
      break;
    }
    const strings = [...f.values.keys()];
    // an instant is what a clock counts to: a date with a time
    const instant =
      f.types.has("string") &&
      strings.length > 0 &&
      strings.every((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v));
    const types =
      ([...f.types].filter((t) => t !== "null").join("|") || "null") +
      (instant ? " (instant)" : "");
    const presence = f.present === f.seen ? "" : ` present ${f.present}/${f.seen}`;
    if (f.types.has("list")) {
      const min = Math.min(...f.lengths);
      const max = Math.max(...f.lengths);
      lines.push(`${path}  list of ${min === max ? min : `${min}–${max}`}${presence}`);
      continue;
    }
    if (f.types.has("object") && !f.values.size) {
      lines.push(`${path}  object${presence}`);
      continue;
    }
    const distinct = [...f.values.entries()];
    const few = distinct.length <= 8 && f.seen >= 2 && distinct.length < f.seen;
    const what = few
      ? ` one of ${distinct.map(([v, n]) => `${JSON.stringify(clip(v, 40))}×${n}`).join(", ")}`
      : distinct[0]
        ? ` e.g. ${JSON.stringify(clip(distinct[0][0], 60))}`
        : "";
    lines.push(`${path}  ${types}${presence}${what}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// A plan, drawn against the sample
// ---------------------------------------------------------------------------

export interface DryRun {
  /** How many items each Repeater drew, by its template's Figma id. */
  repeats: Array<{ template: string; over: string; items: number; most: number }>;
  /** Props whose refs did not resolve, per node, with the item they failed on. */
  unresolved: Array<{
    src: string;
    prop: string;
    value: string;
    missing: string[];
    times: number;
    example: string;
  }>;
  /** Items of a repeat whose children all carry `when` and of which none, or more than one, drew. */
  variants: Array<{ template: string; drew: number; times: number; example: string }>;
  /** What the first items show, per bound node: what a person would read on the page. */
  samples: Array<{ src: string; prop: string; values: string[] }>;
  /** Texts the design writes in capitals that the data draws in lower case, with no `textCase` set. */
  capitals: Array<{ src: string; design: string; shows: string }>;
  /** Short texts the design writes over several lines that the data draws on one. */
  breaks: Array<{ src: string; design: string; shows: string }>;
  /** Pictures bound to a value no browser can load: a path with no domain. */
  relative: Array<{ src: string; shows: string; times: number }>;
  /**
   * The first absolute URL each picture was bound to, whole, and the first few items' (`urls`):
   * what a reachability probe asks. Several items' URLs show a site that answers every id with its
   * stand-in.
   */
  pictures: Array<{ src: string; url: string; urls: string[] }>;
  /** Unbound texts with figures in them, drawn the same in every item of a list: placeholders. */
  repeated: Array<{ src: string; copy: string; times: number }>;
  /**
   * Short texts with a number in them that the data draws in another form than the design's
   * (`formOf`: digits, words and punctuation compared, case aside).
   */
  formats: Array<{ src: string; design: string; shows: string }>;
  /**
   * Variants of a list's items (children that each carry a `when`) that no item of the sample
   * draws. `made` says it was drawn once on an item made from the sample's shape, so its refs
   * were checked too; not made when its `when` is not one an item's own field decides.
   */
  unseen: Array<{
    template: string;
    src: string;
    when: string;
    made: boolean;
    /**
     * Refs that read nothing on the item made for it: fields only that shape's items have, which
     * a copy of another item cannot hold. Unseen, not wrong.
     */
    missing?: string[];
  }>;
}

/** One thing each card shows, as code reads it from the design: the model names it. */
export interface NeedField {
  /** The Figma id of the node that shows it. */
  node: string;
  /** What the node is: a text, or a picture. */
  drawnAs: "text" | "picture";
  /** The design's placeholder, as drawn: "21 JULY", "166/5". Empty for a picture. */
  example: string;
  /** What the design's other cards show at this place, when it differs from the first card's. */
  othersShow?: string[];
}

/**
 * The texts at one place that differ between the design's cards: the first card's node, and what
 * each card shows there, in order. Cards whose texts do not line up one for one are not compared.
 * What the difference means (other examples of one value, or a label that changes with the item)
 * is not said: the binder reads it.
 */
export function varyingTexts(
  tree: Tree,
  members: string[],
): Array<{ src: string; texts: string[] }> {
  const kids = childrenOf(tree);
  const textsOf = (src: string): Array<{ src: string; text: string }> => {
    const start = tree.nodes.find((n) => n.src === src);
    if (!start) return [];
    const out: Array<{ src: string; text: string }> = [];
    const walk = (n: TreeNode) => {
      const c = n.props.content;
      if (n.type === "Text" && typeof c === "string" && c.trim()) out.push({ src: n.src, text: c });
      for (const k of kids.get(n.id) ?? []) walk(k);
    };
    walk(start);
    return out;
  };
  const cards = members.map(textsOf);
  const first = cards[0] ?? [];
  if (cards.length < 2 || cards.some((c) => c.length !== first.length)) return [];
  return first.flatMap((node, i) => {
    const texts = cards.map((c) => c[i]?.text ?? "");
    return new Set(texts).size > 1 ? [{ src: node.src, texts }] : [];
  });
}

/**
 * The draft of a need that code can build from the design: how many items the list draws and
 * what its first card shows, each with the design's placeholder (and what the other cards show
 * there, when they differ). What kind of value each is, and what the list is, are the model's to
 * read: it names the list and each field, and adds `must`.
 */
export function draftNeed(
  tree: Tree,
  group: { members: string[] },
  /** Every repeat of the frame: an inner one's fields are its own list's, never this one's. */
  repeats: ReadonlyArray<{ parent: string; members: string[] }> = [],
): { count: number | "data"; item: NeedField[] } | undefined {
  const first = tree.nodes.find((n) => n.src === group.members[0]);
  if (!first) return undefined;
  // the cards of a carousel are what fits on view, not how many the list has: a looping rail of
  // only those it draws leaves a gap where it bleeds past its box
  const scrolls = tree.nodes.find((n) => n.id === first.parent)?.type === "Carousel";
  const kids = childrenOf(tree);
  // the members of a repeat inside the card (two match panels in a day card): their fields go to
  // that list's own draft
  const under = new Set(subtree(first.id, kids));
  const insideSrcs = new Set(tree.nodes.filter((n) => under.has(n.id)).map((n) => n.src));
  const inner = new Set(
    repeats
      .filter((r) => r.members !== group.members && insideSrcs.has(r.parent))
      .flatMap((r) => r.members),
  );
  const item: NeedField[] = [];
  const walkCard = (node: TreeNode) => {
    if (node !== first && inner.has(node.src)) return;
    if (
      node.type === "Text" &&
      typeof node.props.content === "string" &&
      node.props.content.trim()
    ) {
      item.push({ node: node.src, drawnAs: "text", example: clip(node.props.content, 40) });
    } else if (node.type === "Image") {
      item.push({ node: node.src, drawnAs: "picture", example: "" });
    }
    for (const child of kids.get(node.id) ?? []) walkCard(child);
  };
  walkCard(first);
  const varying = new Map(varyingTexts(tree, group.members).map((v) => [v.src, v.texts]));
  for (const field of item) {
    const texts = varying.get(field.node);
    if (texts) field.othersShow = [...new Set(texts.map((t) => clip(t, 40)))].slice(0, 6);
  }
  return { count: scrolls ? "data" : group.members.length, item };
}

/** `@fanos/dsl`'s `readDate`: a date as epoch ms, read as every part of the page reads it. */
export type ReadDate = (
  value: unknown,
  options?: { timeZone?: string; dateOrder?: "dmy" | "mdy" },
) => number | undefined;

/**
 * A value as the instant it names (epoch ms), by the DSL's own date reading; undefined for what it
 * does not read as a date. A plain number, or a string of digits only, is an instant only when it
 * is epoch-sized: a count or an id is not a date.
 */
export function dateKey(
  readDate: ReadDate,
  options: { timeZone?: string; dateOrder?: "dmy" | "mdy" } = {},
): (value: unknown) => number | undefined {
  return (value) => {
    if (typeof value === "number") return value >= 1e9 ? readDate(value, options) : undefined;
    if (typeof value !== "string" || /^\s*-?\d+\s*$/.test(value)) return undefined;
    return readDate(value, options);
  };
}

/** The item fields a collapse binds, in the plan's order, without the alias or any pipe. */
function fieldPaths(c: {
  as: string;
  fields?: Array<{ path?: string; template?: string }>;
  variants?: Array<{ fields?: Array<{ path?: string; template?: string }> }>;
}): string[] {
  const own = (path: string) => {
    const bare = (path.split("|")[0] ?? "").trim();
    return bare.startsWith(`${c.as}.`) ? bare.slice(c.as.length + 1) : bare;
  };
  const out: string[] = [];
  for (const f of [...(c.fields ?? []), ...(c.variants ?? []).flatMap((v) => v.fields ?? [])]) {
    if (f.path) out.push(own(f.path));
    for (const [, ref] of (f.template ?? "").matchAll(/\{([^{}]+)\}/g)) {
      const path = (ref ?? "").split("|")[0]?.trim() ?? "";
      if (path.startsWith(`${c.as}.`)) out.push(own(path));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined),
      value,
    );

/** How a list's dates run, item to item. */
export type DateRun = "earliest first" | "latest first" | "neither";

/**
 * The order each list a plan draws comes in, by the dates it binds (`data`, by the names the plan
 * reads it by): the first field the plan binds from each item that the DSL reads as a date for
 * most items, its values as the data gives them, how they run, and how many are before `now`. It
 * judges nothing: which order the design means is the binder's to read.
 */
export function datesInOrder(
  plan:
    | {
        collapse?: Array<{
          over: string;
          as: string;
          fields?: Array<{ path?: string; template?: string }>;
          variants?: Array<{ fields?: Array<{ path?: string; template?: string }> }>;
        }>;
      }
    | undefined,
  data: unknown,
  keyOf: (value: unknown) => number | undefined,
  now: number = Date.now(),
): Array<{ over: string; path: string; values: string[]; run: DateRun; past: number; of: number }> {
  const out: Array<{
    over: string;
    path: string;
    values: string[];
    run: DateRun;
    past: number;
    of: number;
  }> = [];
  for (const c of plan?.collapse ?? []) {
    const list = at(data, c.over);
    if (!Array.isArray(list) || list.length < 2) continue;
    for (const path of fieldPaths(c)) {
      const values = list.map((item) => at(item, path));
      const dated = values.flatMap((v) => {
        const key = keyOf(v);
        return key === undefined ? [] : [{ key, value: v }];
      });
      // a field the DSL reads as a date for most items: what the list runs by
      if (dated.length < 2 || dated.length < values.filter((v) => v != null).length / 2) continue;
      const keys = dated.map((d) => d.key);
      const up = keys.every((k, i) => i === 0 || (keys[i - 1] ?? k) <= k);
      const down = keys.every((k, i) => i === 0 || (keys[i - 1] ?? k) >= k);
      out.push({
        over: c.over,
        path,
        values: dated.slice(0, 6).map((d) => clip(String(d.value), 32)),
        run:
          up && !down
            ? "earliest first"
            : down && !up
              ? "latest first"
              : up
                ? "earliest first"
                : "neither",
        past: keys.filter((k) => k < now).length,
        of: keys.length,
      });
      break;
    }
  }
  return out;
}

/**
 * What a person or the model needs to settle a picture the data does not give each item: the
 * item's id field with two real values, the fields that look like picture URLs, and the club's
 * `media.*` facts that build a URL from a field. Read from the sample alone.
 */
export function pictureEvidence(
  sample: unknown,
  mediaFacts: ReadonlyArray<{ key: string | null; content: string }> = [],
): string {
  let items: Array<Record<string, unknown>> | undefined;
  const find = (value: unknown, depth: number) => {
    if (items || depth > 5 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const objects = value.filter(
        (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v),
      );
      if (objects.length >= 2) items = objects;
      else for (const v of value) find(v, depth + 1);
      return;
    }
    for (const v of Object.values(value)) find(v, depth + 1);
  };
  find(sample, 0);
  const rows = (items ?? []) as Array<Record<string, unknown>>;
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const idField = fields.find(
    (f) =>
      /^(id|.*_?id)$/i.test(f) &&
      rows.some((r) => typeof r[f] === "string" || typeof r[f] === "number"),
  );
  const idValues = idField
    ? rows
        .slice(0, 2)
        .map((r) => JSON.stringify(r[idField]))
        .join(", ")
    : "";
  const urlish = fields.filter((f) =>
    rows.some(
      (r) =>
        typeof r[f] === "string" &&
        /^(https?:\/\/|\/).*\.(png|jpe?g|webp|svg|gif|avif)\b/i.test(String(r[f])),
    ),
  );
  const media = mediaFacts
    .filter((f) => f.key?.startsWith("media."))
    .map((f) => `${f.key}: ${f.content}`);
  return [
    idField ? `The items carry ${idField} (e.g. ${idValues}).` : "The items carry no id field.",
    urlish.length
      ? `Fields that look like picture URLs: ${urlish.join(", ")}.`
      : "No field looks like a picture URL.",
    media.length
      ? `House facts that build one: ${media.join(" | ")}.`
      : "No media.* house fact builds one.",
  ].join(" ");
}

/** A field whose key names a team or club, and one whose key names a competition. */
const NAMES = {
  team: /team|club|franchise/i,
  competition: /competition|league|series|tournament|championship/i,
} as const;

/** What one list's items name, by the kind of name their field's key says it holds. */
export interface NamesIn {
  /** The list's path, `[]` for each item of an outer list. */
  list: string;
  kind: keyof typeof NAMES;
  /** The keys that hold them, and the names most items hold, most often first. */
  fields: string[];
  names: Array<{ name: string; items: number }>;
  /** How many items the list has. */
  of: number;
}

/**
 * What the data's items name, from the fields whose key says they name a team or a competition
 * (`team`, `home_team.name`, `league`): for each list of objects, the names its items hold and how
 * often. Read so the binder can compare them with what the design is about; it judges nothing. A
 * list whose items have no such field (articles, a squad's players) is not listed.
 */
export function namesIn(data: unknown, max = 5): NamesIn[] {
  const out: NamesIn[] = [];
  const namesOf = (item: unknown) => {
    const found = {
      team: [] as Array<{ key: string; v: string }>,
      competition: [] as Array<{ key: string; v: string }>,
    };
    const walk = (value: unknown, keys: string[], depth: number) => {
      if (depth > 4) return;
      if (typeof value === "string") {
        const v = value.trim();
        if (!v || v.length > 60 || !/\p{L}/u.test(v) || /^(https?:)?\/\//i.test(v)) return;
        for (const kind of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
          if (keys.some((k) => NAMES[kind].test(k))) found[kind].push({ key: keys.join("."), v });
        }
      } else if (Array.isArray(value)) {
        for (const v of value.slice(0, 20)) walk(v, keys, depth + 1);
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, [...keys, k], depth + 1);
      }
    };
    walk(item, [], 0);
    return found;
  };
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const objects = value.filter(
        (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v),
      );
      if (objects.length > 0) {
        const items = objects.slice(0, 200).map(namesOf);
        for (const kind of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
          const counts = new Map<string, number>();
          const fields = new Set<string>();
          for (const i of items) {
            for (const f of i[kind]) fields.add(f.key);
            for (const n of new Set(i[kind].map((f) => f.v)))
              counts.set(n, (counts.get(n) ?? 0) + 1);
          }
          if (counts.size === 0) continue;
          out.push({
            list: path,
            kind,
            fields: [...fields].slice(0, 4),
            names: [...counts]
              .sort((a, b) => b[1] - a[1])
              .slice(0, max)
              .map(([name, n]) => ({ name, items: n })),
            of: items.length,
          });
        }
        visit(objects[0], `${path}[]`, depth + 1);
      }
      return;
    }
    for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(data, "", 0);
  return out;
}

/** What `namesIn` found, as lines a binder reads beside what the design is about. */
export function describeNames(found: NamesIn[]): string[] {
  return found.map(
    (n) =>
      `${n.list || "(top)"}: its ${n.of} item(s) name the ${n.kind} ${n.names.map((x) => `"${x.name}"${x.items > 1 ? ` (${x.items})` : ""}`).join(", ")} in ${n.fields.join(", ")}`,
  );
}

/**
 * The words of a list's own section: the texts around it that are no item's (its heading, a
 * label beside it), up to the widest block that holds no other list. A "Next" arrow or a column
 * header inside the cards, or another list's heading, is not its.
 */
export function sectionWords(
  tree: Tree,
  group: { parent: string; members: string[] },
  repeats: ReadonlyArray<{ parent: string; members: string[] }>,
): string[] {
  const kids = childrenOf(tree);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const bySrc = new Map(tree.nodes.map((n) => [n.src, n]));
  const srcsUnder = (node: TreeNode) =>
    new Set(subtree(node.id, kids).map((id) => byId.get(id)?.src ?? id));
  // every item's content, of every list: not a heading
  const items = new Set(
    repeats.flatMap((r) =>
      r.members.flatMap((m) => {
        const node = bySrc.get(m);
        return node ? [...srcsUnder(node)] : [];
      }),
    ),
  );
  const start = bySrc.get(group.parent);
  if (!start) return [];
  const mine = srcsUnder(start);
  // another list: one neither inside this one's block nor holding it (a day card's matches are
  // inside the days, and the days' heading is theirs too)
  const holdsThis = (r: { members: string[] }) =>
    r.members.some((m) => {
      const node = bySrc.get(m);
      return node !== undefined && srcsUnder(node).has(group.parent);
    });
  const others = repeats.filter(
    (r) => r.parent !== group.parent && !mine.has(r.parent) && !holdsThis(r),
  );
  let block = start;
  for (
    let up = start.parent === null ? undefined : byId.get(start.parent);
    up;
    up = up.parent === null ? undefined : byId.get(up.parent)
  ) {
    const holds = srcsUnder(up);
    if (others.some((r) => holds.has(r.parent))) break;
    block = up;
  }
  const words: string[] = [];
  for (const id of subtree(block.id, kids)) {
    const node = byId.get(id);
    const text = node?.type === "Text" ? node.props.content : undefined;
    if (!node || items.has(node.src) || typeof text !== "string" || !text.trim()) continue;
    if (!words.includes(text.trim())) words.push(text.trim());
  }
  return words;
}

/**
 * How many items of one shape sit inside the first card of a list (two match panels in one
 * card, a day's matches): the design groups its items, and a hook that gives one item at a time
 * hides all but the first. 0 when the card holds no such inner repeat.
 */
export function cardHolds(
  tree: Tree,
  repeats: Array<{ parent: string; members: string[] }>,
  group: { members: string[] },
): number {
  const first = tree.nodes.find((n) => n.src === group.members[0]);
  if (!first) return 0;
  const under = new Set(subtree(first.id, childrenOf(tree)));
  const inside = new Set(tree.nodes.filter((n) => under.has(n.id)).map((n) => n.src));
  return Math.max(
    0,
    ...repeats
      .filter((r) => r.members !== group.members && inside.has(r.parent) && r.members.length >= 2)
      .map((r) => r.members.length),
  );
}

/** The refs of a template that read nothing (absent, null or empty) and have no `default` pipe. */
function emptyRefs(template: string, scope: unknown, dsl: Pick<Dsl, "lookup">): string[] {
  const empty: string[] = [];
  for (const [, ref] of template.matchAll(/\{([^{}]+)\}/g)) {
    const [path, ...pipes] = (ref ?? "").split("|").map((part) => part.trim());
    if (!path || pipes.some((pipe) => /^default\b/.test(pipe))) continue;
    const value = dsl.lookup(scope, path);
    if (value === undefined || value === null || value === "") empty.push(path);
  }
  return empty;
}

const shouts = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();

/** A short label for an item: its few-valued scalar fields, so a failure can be traced. */
function labelOf(item: unknown): string {
  if (!item || typeof item !== "object") return JSON.stringify(item);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === "string" && v.length <= 24) parts.push(`${k}=${v}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
    if (parts.length >= 4) break;
  }
  return `{${parts.join(", ")}}`;
}

export function dryRun(
  tree: Tree,
  data: unknown,
  dsl: Pick<
    Dsl,
    | "resolveTemplate"
    | "evaluateWhen"
    | "lookup"
    | "hasRef"
    | "clockScope"
    | "overChoice"
    | "overLists"
    | "itemScope"
    | "fillImageRatio"
  >,
  /** The frame before binding: its copy is what each text looked like in the design. */
  design?: Tree,
  /** The time clocks are read at, epoch ms. */
  now: number = Date.now(),
): DryRun {
  const kids = childrenOf(tree);
  const copy = new Map<string, string>();
  for (const node of design?.nodes ?? []) {
    if (node.type === "Text" && typeof node.props.content === "string") {
      copy.set(node.src, node.props.content);
    }
  }
  const capitals = new Map<string, DryRun["capitals"][number]>();
  const formats = new Map<string, DryRun["formats"][number]>();
  const breaks = new Map<string, DryRun["breaks"][number]>();
  const repeated = new Map<string, DryRun["repeated"][number]>();
  const root = tree.nodes.find((n) => n.parent === null);
  const repeats = new Map<string, { over: string; items: number; most: number }>();
  const unresolved = new Map<string, DryRun["unresolved"][number]>();
  const variants = new Map<string, DryRun["variants"][number]>();
  const samples = new Map<string, DryRun["samples"][number]>();
  const relative = new Map<string, DryRun["relative"][number]>();
  const pictures = new Map<string, string[]>();
  // the variants of each list's items, which an item of the sample drew, and one item to make more from
  const choices = new Map<
    string,
    {
      as: string;
      kids: TreeNode[];
      drew: Set<string>;
      first?: { scope: Record<string, unknown>; item: unknown };
    }
  >();
  // true while a variant no item draws is drawn once on an item made for it: its refs are checked,
  // what it shows is not what the data shows
  let making = false;
  /** What the refs drawn on a made item read nothing at: reported with the variant, not as holes. */
  let madeMissing = new Set<string>();

  const props = (node: TreeNode, scope: unknown, item: string) => {
    for (const [prop, value] of Object.entries(node.props)) {
      if (typeof value !== "string" || !dsl.hasRef(value)) continue;
      const resolved = dsl.resolveTemplate(value, scope);
      const drawn = resolved.value;
      // a null reads as "" without complaint: on the page it is a hole all the same
      const missing = [...new Set([...resolved.unresolved, ...emptyRefs(value, scope, dsl)])];
      const key = `${node.src}|${prop}`;
      const placeholder = copy.get(node.src);
      if (
        prop === "content" &&
        placeholder !== undefined &&
        shouts(placeholder) &&
        /[a-z]/.test(drawn) &&
        node.props.textCase !== "upper" &&
        !capitals.has(node.src)
      ) {
        capitals.set(node.src, { src: node.src, design: placeholder, shows: clip(drawn, 40) });
      }
      // a short text with a number drawn in another form than the design's: "5/26/2026" for "21 JULY"
      if (
        prop === "content" &&
        placeholder !== undefined &&
        hasForm(placeholder) &&
        // a dash is the default a template falls back to for a value an item lacks, not a form
        !/^[\p{P}\p{S}\s]*$/u.test(drawn) &&
        !formats.has(node.src)
      ) {
        // case is the capitals check's (and textCase's): the form is compared case-folded on
        // both sides, so "21 July" drawn upper is "21 JULY"'s form
        if (formOf(drawn.toLowerCase()) !== formOf(placeholder.toLowerCase())) {
          formats.set(node.src, {
            src: node.src,
            design: placeholder,
            shows: clip(drawn, 40),
          });
        }
      }
      // a short text the design writes over lines, drawn on one (a paragraph wraps: not compared)
      if (
        prop === "content" &&
        placeholder !== undefined &&
        placeholder.includes("\n") &&
        placeholder.length <= 60 &&
        placeholder.split("\n").length <= 3 &&
        drawn !== "" &&
        !drawn.includes("\n") &&
        !breaks.has(node.src)
      ) {
        breaks.set(node.src, { src: node.src, design: placeholder, shows: clip(drawn, 40) });
      }
      if (missing.length && making) {
        for (const m of missing) madeMissing.add(m);
      } else if (missing.length) {
        const u = unresolved.get(key) ?? {
          src: node.src,
          prop,
          value,
          missing,
          times: 0,
          example: item,
        };
        u.times += 1;
        unresolved.set(key, u);
      } else {
        // a picture needs a URL the browser can reach: "/static/a.jpg" is a path on no site
        if (prop === "src" && drawn !== "" && !/^(https?:)?\/\/|^data:/i.test(drawn)) {
          const r = relative.get(key) ?? { src: node.src, shows: clip(drawn, 60), times: 0 };
          r.times += 1;
          relative.set(key, r);
        }
        if (prop === "src" && /^https?:\/\//i.test(drawn)) {
          // the URL the browser asks for: the CDN's {{RATIO}} slot filled from the Image's ratio, as
          // the renderer fills it (the slot left in answers a 68-byte stand-in; run 3b826dc5)
          const ratio = typeof node.props.ratio === "string" ? node.props.ratio : undefined;
          const fetched = node.type === "Image" ? dsl.fillImageRatio(drawn, ratio) : drawn;
          const urls = pictures.get(node.src) ?? [];
          if (urls.length < 3 && !urls.includes(fetched)) urls.push(fetched);
          pictures.set(node.src, urls);
        }
        if (!making) {
          const s = samples.get(key) ?? { src: node.src, prop, values: [] };
          if (s.values.length < 4 && !s.values.includes(drawn)) s.values.push(clip(drawn, 60));
          samples.set(key, s);
        }
      }
    }
  };

  const walk = (node: TreeNode, outer: unknown, item: string) => {
    let scope = outer;
    // a clock is in scope on its own node, as the renderer reads it
    if (node.props.clock !== undefined) {
      const clock = dsl.clockScope(node.props.clock, outer, now);
      const key = `${node.src}|clock`;
      if (!clock?.values && making) {
        madeMissing.add(clock ? "an instant" : "a clock");
      } else if (!clock?.values) {
        const u = unresolved.get(key) ?? {
          src: node.src,
          prop: "clock.to",
          value: JSON.stringify(
            (node.props.clock as { to?: unknown } | null)?.to ?? node.props.clock,
          ),
          missing: [clock ? "an instant" : "a clock: { to, as, units }"],
          times: 0,
          example: item,
        };
        u.times += 1;
        unresolved.set(key, u);
      } else {
        scope = { ...(outer as object), [clock.as]: clock.values };
      }
    }
    if (node.props.when !== undefined && !dsl.evaluateWhen(node.props.when, scope)) return;
    if (node.type === "Repeater") {
      const given = String(node.props.over ?? "");
      // a list that follows a page choice is drawn once for each option's list
      // a list that follows a page choice (`squad.{_page.squad}`) is drawn once for each list the
      // data has there, as the page draws it for each option (an ALL option draws them all)
      const lists = dsl.overChoice(given)
        ? dsl.overLists(given, scope).map((l) => ({ over: `${given} (${l.value})`, list: l.items }))
        : [];
      const drawing =
        lists.length > 0 ? lists : [{ over: given, list: dsl.lookup(scope, given) as unknown }];
      for (const { over, list } of drawing) {
        const as = String(node.props.as ?? "item");
        // what it draws between items (`separator`) is no item's: not one of its shapes
        const between = new Set(
          Array.isArray(node.props.separator) ? (node.props.separator as string[]) : [],
        );
        const children = (kids.get(node.id) ?? []).filter((c) => !between.has(c.id));
        const template = children[0]?.src ?? node.src;
        const items = Array.isArray(list) ? sliceOf(list, node.props) : [];
        const r = repeats.get(template) ?? { over, items: 0, most: 0 };
        r.items += items.length;
        r.most = Math.max(r.most, items.length);
        repeats.set(template, r);
        if (!Array.isArray(list)) {
          const key = `${node.src}|over`;
          const u = unresolved.get(key) ?? {
            src: template,
            prop: "over",
            value: over,
            missing: [over],
            times: 0,
            example: item,
          };
          u.times += 1;
          unresolved.set(key, u);
        }
        const choosy = children.length > 1 && children.every((c) => c.props.when !== undefined);
        const mark = choosy
          ? (choices.get(template) ?? { as, kids: children, drew: new Set<string>() })
          : undefined;
        if (mark) choices.set(template, mark);
        for (const each of items) {
          // as the renderer scopes an item: the item by its name, and its list under `_each`
          const inner = dsl.itemScope(scope, as, each, items);
          const label = labelOf(each);
          if (choosy) {
            // a card's own clock is in scope in its `when`, as the renderer reads it
            const drawn = children.filter((c) => {
              const clock =
                c.props.clock === undefined ? undefined : dsl.clockScope(c.props.clock, inner, now);
              const at = clock?.values ? { ...inner, [clock.as]: clock.values } : inner;
              return dsl.evaluateWhen(c.props.when, at);
            });
            const drew = drawn.length;
            for (const c of drawn) mark?.drew.add(c.id);
            if (mark && !mark.first)
              mark.first = { scope: inner as Record<string, unknown>, item: each };
            if (drew !== 1) {
              const key = `${template}|${drew}`;
              const v = variants.get(key) ?? { template, drew, times: 0, example: label };
              v.times += 1;
              variants.set(key, v);
            }
          }
          for (const child of children) walk(child, inner, label);
        }
      }
      return;
    }
    props(node, scope, item);
    const copy = node.props.content;
    if (
      item !== "page" &&
      node.type === "Text" &&
      typeof copy === "string" &&
      /\d/.test(copy) &&
      !dsl.hasRef(copy)
    ) {
      const r = repeated.get(node.src) ?? { src: node.src, copy: clip(copy, 30), times: 0 };
      r.times += 1;
      repeated.set(node.src, r);
    }
    for (const child of kids.get(node.id) ?? []) walk(child, scope, item);
  };
  if (root) walk(root, data, "page");

  // A variant no item of the sample draws (every match was a result, so the upcoming card never
  // was): said, and drawn once on an item made from the sample's shape with the variant's state,
  // so its refs are checked too.
  const unseen: DryRun["unseen"] = [];
  for (const [template, choice] of choices) {
    for (const kid of choice.kids.filter((k) => !choice.drew.has(k.id))) {
      const when = JSON.stringify(kid.props.when);
      let made = false;
      if (choice.first) {
        const item = madeFor(kid.props.when, choice.as, choice.first.item);
        const at = item === undefined ? undefined : { ...choice.first.scope, [choice.as]: item };
        if (at && dsl.evaluateWhen(kid.props.when, at)) {
          made = true;
          making = true;
          madeMissing = new Set();
          walk(kid, at, `(an item made for ${when})`);
          making = false;
        }
      }
      unseen.push({
        template,
        src: kid.src,
        when,
        made,
        ...(made && madeMissing.size > 0 ? { missing: [...madeMissing] } : {}),
      });
    }
  }

  return {
    repeats: [...repeats.entries()].map(([template, r]) => ({ template, ...r })),
    unresolved: [...unresolved.values()],
    variants: [...variants.values()],
    samples: [...samples.values()],
    relative: [...relative.values()],
    pictures: [...pictures].map(([src, urls]) => ({ src, url: urls[0] ?? "", urls })),
    capitals: [...capitals.values()],
    breaks: [...breaks.values()],
    repeated: [...repeated.values()].filter((r) => r.times > 1),
    formats: [...formats.values()],
    unseen,
  };
}

/**
 * A copy of `item` that the variant's `when` matches: each `eq` condition on one of the item's
 * own fields (`match.state eq "U"`) set. Undefined when the `when` reads anything else (a clock,
 * a page choice, an `exists`): no item can be made for it from the sample's shape.
 */
function madeFor(when: unknown, as: string, item: unknown): unknown {
  if (!item || typeof item !== "object") return undefined;
  const copy = structuredClone(item) as Record<string, unknown>;
  for (const cond of Array.isArray(when) ? when : [when]) {
    const c = cond as { path?: unknown; eq?: unknown };
    if (typeof c?.path !== "string" || c.eq === undefined || !c.path.startsWith(`${as}.`)) {
      return undefined;
    }
    const keys = c.path.slice(as.length + 1).split(".");
    let at: Record<string, unknown> = copy;
    for (const key of keys.slice(0, -1)) {
      const next = at[key];
      at[key] = next && typeof next === "object" ? next : {};
      at = at[key] as Record<string, unknown>;
    }
    at[keys.at(-1) as string] = c.eq;
  }
  return copy;
}

// The props that are how a node looks, not where it sits: instances of one card differ in sizes
// and alignment by their copy, never in these unless the design means it.
const LOOK = ["tone", "style", "surface", "textCase", "variant"] as const;

/**
 * Where the members of a list differ in look from the first, node for node: a collapse draws every
 * item like the first, so these looks would be lost. Only members of the template's skeleton are
 * compared: one built differently is another shape (a variant), not the same thing restyled.
 */
export function lostLooks(
  tree: Tree,
  members: string[],
  /** Template nodes (by Figma id) whose looks by place the fold keeps (`at`): not lost. */
  kept: ReadonlySet<string> = new Set(),
): string[] {
  const kids = childrenOf(tree);
  const sk = skeletons(tree);
  const bySrc = new Map(tree.nodes.map((node) => [node.src, node]));
  const template = bySrc.get(members[0] ?? "");
  if (!template) return [];
  const found: string[] = [];
  const compare = (a: TreeNode, b: TreeNode) => {
    for (const prop of kept.has(a.src) ? [] : LOOK) {
      const x = JSON.stringify(a.props[prop]);
      const y = JSON.stringify(b.props[prop]);
      if (x !== y) found.push(`${b.src} ${prop} ${y ?? "none"} where ${a.src} has ${x ?? "none"}`);
    }
    const ak = kids.get(a.id) ?? [];
    const bk = kids.get(b.id) ?? [];
    if (ak.length !== bk.length) return;
    ak.forEach((child, i) => {
      const other = bk[i];
      if (other && other.type === child.type) compare(child, other);
    });
  };
  for (const src of members.slice(1)) {
    const member = bySrc.get(src);
    // another shape is a variant or a fold, not the same thing in another look
    if (member && sk.get(member.id) === sk.get(template.id)) compare(template, member);
  }
  return found;
}

export interface OwnPicture {
  /** The picture's node in each member, the first member's first: the place it is in a card. */
  srcs: string[];
  alt: string;
  /** The picture's box in the design, "w x h px", when the design fixed its size. */
  box?: string;
  /** How many different pictures the design gives that place across the members. */
  distinct: number;
  /** A glyph (an Icon), not a picture file: a mark the design draws, which a plan may keep with why. */
  icon?: true;
}

/** The box a node's size fixes, as "w x h px": a plain number or `{ raw }` on each side. */
function boxOf(node: TreeNode): { box?: string } {
  const size = node.props.size as { w?: unknown; h?: unknown } | undefined;
  const px = (v: unknown) =>
    typeof v === "number"
      ? v
      : v && typeof v === "object" && typeof (v as { raw?: unknown }).raw === "number"
        ? (v as { raw: number }).raw
        : undefined;
  const w = px(size?.w);
  const h = px(size?.h);
  return w !== undefined && h !== undefined
    ? { box: `${Math.round(w)} x ${Math.round(h)} px` }
    : {};
}

/** What a picture shows: an Image's file, an Icon's glyph (a crest drawn as a vector is an Icon). */
const pictureOf = (node: TreeNode) =>
  node.type === "Image"
    ? String(node.props.src ?? "")
    : node.type === "Icon"
      ? String(node.props.name ?? "")
      : undefined;

/**
 * Each node of a member by its place in the member: an instance's layer id with the member's own
 * prefix taken off (`I35:10531;10111:12374` is `10111:12374` in `35:10531`), so card 2's photo is
 * found where card 1's is, whatever badge or icon one card has and the other lacks. A node that is
 * not part of the instance is placed by its path of child positions.
 */
function placesOf(member: TreeNode, kids: Map<string, TreeNode[]>): Map<string, TreeNode> {
  const prefix = `I${member.src};`;
  const out = new Map<string, TreeNode>();
  const walk = (node: TreeNode, path: string) => {
    const key = node.src.startsWith(prefix) ? node.src.slice(prefix.length) : path;
    if (!out.has(key)) out.set(key, node);
    for (const [i, child] of (kids.get(node.id) ?? []).entries()) walk(child, `${path}/${i}`);
  };
  for (const [i, child] of (kids.get(member.id) ?? []).entries()) walk(child, `/${i}`);
  return out;
}

/** The parts one member has that the other lacks, outermost only: a badge is one, not its text too. */
function outermostDifferences(a: Map<string, TreeNode>, b: Map<string, TreeNode>): number {
  const only = (x: Map<string, TreeNode>, y: Map<string, TreeNode>) => {
    const missing = [...x.keys()].filter((key) => !y.has(key));
    const srcOf = new Map([...x].map(([key, node]) => [node.id, key]));
    const ids = new Set(missing.map((key) => x.get(key)?.id));
    // a part inside another missing part is that part
    return missing.filter((key) => {
      const node = x.get(key);
      const parentKey = node?.parent ? srcOf.get(node.parent) : undefined;
      return !(parentKey !== undefined && ids.has(x.get(parentKey)?.id));
    }).length;
  };
  return only(a, b) + only(b, a);
}

/**
 * The members built like the template, each with its places: the same thing with a badge more or
 * less. A member that shares under 80% of the template's places, or of its own, is another shape
 * (a variant).
 */
function alike(tree: Tree, members: string[]) {
  const kids = childrenOf(tree);
  const bySrc = new Map(tree.nodes.map((node) => [node.src, node]));
  const placed = members.flatMap((src) => {
    const node = bySrc.get(src);
    return node ? [{ src, node, places: placesOf(node, kids) }] : [];
  });
  const [template, ...rest] = placed;
  if (!template) return [];
  const like = rest.filter((m) => {
    let shared = 0;
    for (const key of template.places.keys()) if (m.places.has(key)) shared += 1;
    // both ways: a card with much the template lacks is another shape, though it has all of it
    if (shared >= 0.8 * template.places.size && shared >= 0.8 * m.places.size) return true;
    // a small card is changed much by one badge: two parts more or less is still the same card
    return outermostDifferences(template.places, m.places) <= 2;
  });
  return [template, ...like];
}

/**
 * The pictures the design gives each member of a repeat its own of: a photo, a crest, a
 * thumbnail on each card. One picture on every card (a logo, an arrow) is decoration and is left
 * out. Members of another shape are variants, not compared.
 */
export function ownPictures(tree: Tree, members: string[]): OwnPicture[] {
  const [template, ...rest] = alike(tree, members);
  if (!template || rest.length === 0) return [];
  const out: OwnPicture[] = [];
  for (const [key, node] of template.places) {
    const shows = pictureOf(node);
    if (shows === undefined) continue;
    const at = [node, ...rest.map((m) => m.places.get(key))].filter(
      (n): n is TreeNode => n !== undefined && pictureOf(n) !== undefined,
    );
    const distinct = new Set(at.map((n) => pictureOf(n)));
    if (at.length > 1 && distinct.size > 1) {
      out.push({
        srcs: at.map((n) => n.src),
        alt: String(node.props.alt ?? ""),
        ...boxOf(node),
        distinct: distinct.size,
        ...(node.type === "Icon" ? { icon: true as const } : {}),
      });
    }
  }
  return out;
}

export interface SomeOnly {
  /** The node, in the first member that has it. */
  src: string;
  type: string;
  /** What it says, for a text or a node with one text in it. */
  copy?: string;
  /** The members that have it, of `of`. */
  in: string[];
  of: number;
  /** The template has it: a collapse draws it on every item. Otherwise it draws it on none. */
  inTemplate: boolean;
}

/**
 * Parts the design shows on some members only: a captain's badge on two of five cards, a flag on
 * the overseas players. A collapse draws the template, so a part the template has is on every item
 * and a part only others have is on none, unless a `when` on the data decides it. Only the
 * outermost such part is named. Members of another shape are variants, not compared.
 */
export function someOnly(tree: Tree, members: string[]): SomeOnly[] {
  const all = alike(tree, members);
  if (all.length < 2) return [];
  const kids = childrenOf(tree);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const keys = new Map<string, string[]>();
  for (const m of all) {
    for (const key of m.places.keys()) keys.set(key, [...(keys.get(key) ?? []), m.src]);
  }
  const placeOf = new Map<string, string>();
  for (const m of all) for (const [key, node] of m.places) placeOf.set(node.id, key);
  const textIn = (node: TreeNode): string | undefined => {
    if (node.type === "Text") return String(node.props.content ?? "");
    const texts: string[] = [];
    const walk = (n: TreeNode) => {
      if (n.type === "Text") texts.push(String(n.props.content ?? ""));
      for (const c of kids.get(n.id) ?? []) walk(c);
    };
    walk(node);
    return texts.length === 1 ? texts[0] : undefined;
  };
  const shows = (node: TreeNode): boolean =>
    node.type === "Text" || pictureOf(node) !== undefined || (kids.get(node.id) ?? []).some(shows);
  const out: SomeOnly[] = [];
  for (const [key, has] of keys) {
    if (has.length === all.length) continue;
    const owner = all.find((m) => m.src === has[0]);
    const node = owner?.places.get(key);
    if (!owner || !node) continue;
    // the outermost: its parent is the member itself, or a place every member has
    const parent = node.parent === null ? undefined : byId.get(node.parent);
    const parentKey = parent ? placeOf.get(parent.id) : undefined;
    if (
      parent &&
      parent.id !== owner.node.id &&
      (keys.get(parentKey ?? "")?.length ?? 0) !== all.length
    ) {
      continue;
    }
    // a box or a shade one card has and another lacks is decoration; a part shows text or a picture
    if (!shows(node)) continue;
    const copy = textIn(node);
    out.push({
      src: node.src,
      type: node.type,
      ...(copy ? { copy } : {}),
      in: has,
      of: all.length,
      inTemplate: has[0] === all[0]?.src,
    });
  }
  return out;
}

/** The template's parts that every member has, by src: what the design draws on every item. */
export function onEvery(tree: Tree, members: string[]): { srcs: Set<string>; of: number } {
  const all = alike(tree, members);
  const [template, ...rest] = all;
  if (!template || rest.length === 0) return { srcs: new Set(), of: all.length };
  const srcs = new Set<string>();
  for (const [key, node] of template.places)
    if (rest.every((m) => m.places.has(key))) srcs.add(node.src);
  srcs.delete(template.node.src);
  return { srcs, of: all.length };
}

/** Siblings built alike, two or more: the cards, rows or tiles a section repeats, wherever they are. */
export function repeatsOf(tree: Tree): string[][] {
  const sk = skeletons(tree);
  const out: string[][] = [];
  for (const list of childrenOf(tree).values()) {
    const byShape = new Map<string, string[]>();
    for (const node of list) {
      if (CONTENT.has(node.type)) continue;
      const key = sk.get(node.id) ?? "";
      byShape.set(key, [...(byShape.get(key) ?? []), node.src]);
    }
    for (const members of byShape.values()) if (members.length > 1) out.push(members);
  }
  return out;
}

/** The member of `members` each node of the tree is inside, by src. */
export function memberOf(tree: Tree, members: string[]): Map<string, string> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const roots = new Set(members);
  const out = new Map<string, string>();
  for (const node of tree.nodes) {
    let at: TreeNode | undefined = node;
    while (at && !roots.has(at.src)) at = at.parent === null ? undefined : byId.get(at.parent);
    if (at) out.set(node.src, at.src);
  }
  return out;
}

/** The outermost nodes under `root` built like `like`: the items one row of a grid draws. */
function itemsUnder(
  root: TreeNode,
  key: string | undefined,
  kids: Map<string, TreeNode[]>,
  sk: Map<string, string>,
): TreeNode[] {
  const items: TreeNode[] = [];
  if (key === undefined) return items;
  const walk = (node: TreeNode) => {
    if (sk.get(node.id) === key) {
      items.push(node);
      return;
    }
    for (const child of kids.get(node.id) ?? []) walk(child);
  };
  walk(root);
  return items;
}

/**
 * The items of each member of a repeat, when the repeat's first member holds a repeat of its own:
 * the cards in each row of a grid drawn as rows. `groups` names only the first row's cards (a
 * collapse of the rows would fold the others away), so a plan that slices one flat list across the
 * rows reads the other rows' ids here.
 */
export function rowsOf(tree: Tree, outer: Group, inner: Group): string[][] | undefined {
  const bySrc = new Map(tree.nodes.map((n) => [n.src, n]));
  if (bySrc.get(inner.parent) === undefined) return undefined;
  const first = bySrc.get(outer.members[0] ?? "");
  const card = bySrc.get(inner.members[0] ?? "");
  // items are cards, not the pictures layered in one
  if (!first || !card || CONTENT.has(card.type)) return undefined;
  const kids = childrenOf(tree);
  if (!subtree(first.id, kids).includes(card.id)) return undefined;
  const sk = skeletons(tree);
  const key = sk.get(card.id);
  return outer.members.map((src) => {
    const member = bySrc.get(src);
    return member ? itemsUnder(member, key, kids, sk).map((n) => n.src) : [];
  });
}

export interface Unbound {
  /** The text node still showing the designer's copy. */
  src: string;
  copy: string;
  /** The nearest container around it that does show data. */
  within: string;
}

/**
 * Design copy left standing beside data, whatever the layout. A text the plan neither bound nor
 * hid, inside a container that otherwise shows data (a count on a card whose title and date are
 * bound), is a placeholder far more often than a label: labels sit beside other labels, not beside
 * the data they would describe. It looks up at most three containers and never as far as the root,
 * so a page's own headings and buttons stay out, and a block beside a list that holds no data (the
 * section's heading over its cards) is the section's static part, never reported. Nodes inside a repeat, a button or a node the
 * plan gave a `when` are not reported (`dryRun.repeated` has the repeats).
 */
export function unboundCopy(
  applied: Tree,
  hasRef: (value: unknown) => boolean,
  maxUp = 3,
): Unbound[] {
  const kids = childrenOf(applied);
  const byId = new Map(applied.nodes.map((n) => [n.id, n]));
  const shows = new Map<string, boolean>();
  const showsData = (id: string): boolean => {
    const known = shows.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const yes =
      !!node &&
      (node.type === "Repeater" ||
        Object.values(node.props).some(hasRef) ||
        (kids.get(id) ?? []).some((k) => showsData(k.id)));
    shows.set(id, yes);
    return yes;
  };
  const lists = new Map<string, boolean>();
  const holdsList = (id: string): boolean => {
    const known = lists.get(id);
    if (known !== undefined) return known;
    const yes = (kids.get(id) ?? []).some((k) => k.type === "Repeater" || holdsList(k.id));
    lists.set(id, yes);
    return yes;
  };
  const SKIPPED = new Set(["Repeater", "Button", "Link", "Tag"]);
  const out: Unbound[] = [];
  for (const node of applied.nodes) {
    const copy = node.props.content;
    if (node.type !== "Text" || typeof copy !== "string" || !copy.trim()) continue;
    if (hasRef(copy) || node.props.when !== undefined) continue;
    const chain: TreeNode[] = [];
    for (let at = node.parent; at !== null; ) {
      const up = byId.get(at);
      if (!up) break;
      chain.push(up);
      at = up.parent;
    }
    if (chain.some((up) => SKIPPED.has(up.type) || up.props.when !== undefined)) continue;
    chain.slice(0, maxUp).some((up, i) => {
      if (up.parent === null) return true;
      if (!showsData(up.id)) return false;
      // the block beside a list that holds no data of its own (a heading and its button above
      // the cards, a footer's note) is the section's static part, not a placeholder in an item
      const branch = i === 0 ? node : chain[i - 1];
      if (branch && !showsData(branch.id) && holdsList(up.id)) return true;
      out.push({ src: node.src, copy: clip(copy), within: up.src });
      return true;
    });
  }
  return out;
}

export interface LeftAsDesigned {
  /** The member a plan left as the designer drew it. */
  src: string;
  /** Its sibling of the same shape, which draws data. */
  like: string;
  /** The list that sibling repeats, when it repeats one. */
  over?: string;
  /** A placeholder it still shows. */
  copy?: string;
  /** Its own items, each the shape of the template of the sibling's list. */
  items: string[];
}

/**
 * A repeat the plan left showing the design's placeholders, beside a sibling of the same shape
 * that it gave data: the page shows real items next to the designer's dummy copy and pictures.
 *
 * Only containers count (three pictures layered in a card are not a list), and a repeat with no
 * member given data is the plan leaving it on purpose. It says what is there, not how to fix it.
 */
export function leftAsDesigned(
  design: Tree,
  applied: Tree,
  byId: Map<string, IrNode>,
  hasRef: (value: unknown) => boolean,
): LeftAsDesigned[] {
  const kids = childrenOf(applied);
  const designKids = childrenOf(design);
  const sk = skeletons(design);
  const appliedBySrc = new Map(applied.nodes.map((n) => [n.src, n]));
  const designBySrc = new Map(design.nodes.map((n) => [n.src, n]));
  const appliedById = new Map(applied.nodes.map((n) => [n.id, n]));
  const designById = new Map(design.nodes.map((n) => [n.id, n]));

  const insideRepeater = (node: TreeNode): boolean => {
    for (let at = node.parent; at !== null; ) {
      const parent = appliedById.get(at);
      if (!parent) return false;
      if (parent.type === "Repeater") return true;
      at = parent.parent;
    }
    return false;
  };
  const drawn = (node: TreeNode): TreeNode[] =>
    subtree(node.id, kids).flatMap((id) => appliedById.get(id) ?? []);
  const gated = (node: TreeNode): boolean => {
    for (let at: TreeNode | undefined = node; at; ) {
      if (at.props.when !== undefined) return true;
      at = at.parent === null ? undefined : appliedById.get(at.parent);
    }
    return false;
  };
  const drawsData = (node: TreeNode) =>
    insideRepeater(node) ||
    drawn(node).some((n) => n.type === "Repeater" || Object.values(n.props).some(hasRef));

  const out: LeftAsDesigned[] = [];
  for (const group of groups(design, byId)) {
    const members = group.members.flatMap((src) => designBySrc.get(src) ?? []);
    if (members.some((m) => CONTENT.has(m.type))) continue;
    // a member a collapse folded away is drawn by its template: it counts as given data
    const given = members.filter((m) => {
      const now = appliedBySrc.get(m.src);
      return !now || drawsData(now);
    });
    if (given.length === 0 || given.length === members.length) continue;
    const like = given[0];
    if (!like) continue;
    const likeNow = appliedBySrc.get(like.src);
    const repeater = likeNow ? drawn(likeNow).find((n) => n.type === "Repeater") : undefined;
    const template = repeater ? kids.get(repeater.id)?.[0] : undefined;
    const templateKey = template ? sk.get(designBySrc.get(template.src)?.id ?? "") : undefined;
    const itemsOf = (member: TreeNode) => itemsUnder(member, templateKey, designKids, sk);

    for (const member of members) {
      const now = appliedBySrc.get(member.src);
      // a when on it (or around it) is the plan deciding when it draws: hidden where the data has
      // no item for it, as unboundCopy reads one (run 75a770af kept a row its when already hid)
      if (!now || drawsData(now) || gated(now)) continue;
      const nodes = subtree(member.id, designKids).flatMap((id) => designById.get(id) ?? []);
      const items = itemsOf(member);
      // its longest copy says best what it is: a headline, not a badge's "32"
      const text = nodes
        .filter((n) => n.type === "Text" && typeof n.props.content === "string")
        .sort((a, b) => String(b.props.content).length - String(a.props.content).length)[0];
      out.push({
        src: member.src,
        like: like.src,
        ...(repeater && typeof repeater.props.over === "string"
          ? { over: repeater.props.over }
          : {}),
        ...(text ? { copy: clip(String(text.props.content)) } : {}),
        items: items.map((i) => i.src),
      });
    }
  }
  return out;
}

/** How many boxes `pageAsRead` lists before it says how many more there are. */
const PAGE_LINES = 80;

/**
 * The page as a person reads it, box by box: every text, picture and button label it draws, each
 * from the data (with what the sample draws there) or as the designer wrote it, and whether a
 * `when` decides it. It judges nothing: the binder reads it and decides what is data and what
 * stays. A list's template is listed once, as it draws its items.
 */
export function pageAsRead(
  tree: Tree,
  samples: DryRun["samples"],
  hasRef: (value: unknown) => boolean,
): string[] {
  const kids = childrenOf(tree);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const drawn = new Map(samples.map((s) => [`${s.src}|${s.prop}`, s.values]));
  const PROP: Record<string, { prop: string; what: string }> = {
    Text: { prop: "content", what: "text" },
    Image: { prop: "src", what: "picture" },
    Button: { prop: "label", what: "button" },
  };
  const boxes = new Map<string, string[]>();
  const where = (n: TreeNode) => {
    const chain: string[] = [];
    for (let at = n.parent === null ? undefined : byId.get(n.parent); at; ) {
      chain.unshift(at.id);
      at = at.parent === null ? undefined : byId.get(at.parent);
    }
    // the root says nothing; the last three boxes say where on the page it is
    return chain.slice(1).slice(-3).join(" / ") || "(top)";
  };
  const walk = (n: TreeNode) => {
    const kind = PROP[n.type];
    const value = kind ? n.props[kind.prop] : undefined;
    if (kind && value !== undefined && value !== "") {
      const when = n.props.when !== undefined ? " (a when decides it)" : "";
      const part = hasRef(value)
        ? `${kind.what} ${n.id} from the data: ${(drawn.get(`${n.src}|${kind.prop}`) ?? ["nothing"])
            .slice(0, 2)
            .map((v) => JSON.stringify(v))
            .join(", ")}${when}`
        : kind.what === "picture"
          ? `picture ${n.id} as designed${when}`
          : `${kind.what} ${n.id} as designed: ${JSON.stringify(clip(String(value), 40))}${when}`;
      const key = where(n);
      boxes.set(key, [...(boxes.get(key) ?? []), part]);
    }
    for (const k of kids.get(n.id) ?? []) walk(k);
  };
  for (const root of tree.nodes.filter((n) => n.parent === null)) walk(root);
  const lines = [...boxes].map(([box, parts]) => `${box}: ${parts.join("; ")}`);
  return lines.length > PAGE_LINES
    ? [...lines.slice(0, PAGE_LINES), `…and ${lines.length - PAGE_LINES} more boxes`]
    : lines;
}

function sliceOf(list: unknown[], props: Record<string, unknown>): unknown[] {
  // `[start]` runs to the end of the list
  if (Array.isArray(props.slice)) {
    return list.slice(
      Number(props.slice[0]),
      props.slice[1] === undefined ? undefined : Number(props.slice[1]),
    );
  }
  if (typeof props.limit === "number") return list.slice(0, props.limit);
  return list;
}
