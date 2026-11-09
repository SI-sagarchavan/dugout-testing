/**
 * The facts a binder needs, from the frame and the data alone. Deterministic, and about no API in
 * particular: nothing here knows what a match, an article or a score is. The same frame and the
 * same sample always give the same facts, and the model's only job is to read them.
 *
 * - `outline`: the compiled tree as a person would skim it, with what repeats and what is a variant
 *   of one component marked from the Figma structure, not from exact sizes (two instances of one
 *   card differ by their text widths and repairs, and are still one card).
 * - `shapeOf`: the data's paths, types, how often each is present, and the values of the few-valued
 *   ones (the fields a variant can be chosen by).
 * - `dryRun`: a plan applied and drawn against every item of the sample, without a browser: what
 *   would not resolve, and which item draws no variant or two.
 */

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
  /** Texts the design writes in capitals that the data does not, with no `textCase` set. */
  capitals: Array<{ src: string; design: string; shows: string }>;
  /** Short texts the design breaks over lines on purpose that the data draws on one. */
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
  dsl: Pick<Dsl, "resolveTemplate" | "evaluateWhen" | "lookup" | "hasRef" | "clockScope">,
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
  const breaks = new Map<string, DryRun["breaks"][number]>();
  const repeated = new Map<string, DryRun["repeated"][number]>();
  const root = tree.nodes.find((n) => n.parent === null);
  const repeats = new Map<string, { over: string; items: number; most: number }>();
  const unresolved = new Map<string, DryRun["unresolved"][number]>();
  const variants = new Map<string, DryRun["variants"][number]>();
  const samples = new Map<string, DryRun["samples"][number]>();
  const relative = new Map<string, DryRun["relative"][number]>();
  const pictures = new Map<string, string[]>();

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
      // a heading the designer broke by hand ("Ben\nMcKinney"): a paragraph wraps, it is not broken
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
      if (missing.length) {
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
          const urls = pictures.get(node.src) ?? [];
          if (urls.length < 3 && !urls.includes(drawn)) urls.push(drawn);
          pictures.set(node.src, urls);
        }
        const s = samples.get(key) ?? { src: node.src, prop, values: [] };
        if (s.values.length < 4 && !s.values.includes(drawn)) s.values.push(clip(drawn, 60));
        samples.set(key, s);
      }
    }
  };

  const walk = (node: TreeNode, outer: unknown, item: string) => {
    let scope = outer;
    // a clock is in scope on its own node, as the renderer reads it
    if (node.props.clock !== undefined) {
      const clock = dsl.clockScope(node.props.clock, outer, now);
      const key = `${node.src}|clock`;
      if (!clock || !clock.values) {
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
      const over = String(node.props.over ?? "");
      const as = String(node.props.as ?? "item");
      const list = dsl.lookup(scope, over);
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
      for (const each of items) {
        const inner = { ...(scope as object), [as]: each };
        const label = labelOf(each);
        if (choosy) {
          // a card's own clock is in scope in its `when`, as the renderer reads it
          const drew = children.filter((c) => {
            const clock =
              c.props.clock === undefined ? undefined : dsl.clockScope(c.props.clock, inner, now);
            const at = clock?.values ? { ...inner, [clock.as]: clock.values } : inner;
            return dsl.evaluateWhen(c.props.when, at);
          }).length;
          if (drew !== 1) {
            const key = `${template}|${drew}`;
            const v = variants.get(key) ?? { template, drew, times: 0, example: label };
            v.times += 1;
            variants.set(key, v);
          }
        }
        for (const child of children) walk(child, inner, label);
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
  };
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

/** The ratios CMS pictures are cut in, as their file names write them (`9-16-<id>.jpg`). */
const RATIOS: Array<[number, number]> = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [21, 9],
  [4, 5],
  [5, 4],
  [2, 1],
  [1, 2],
];

/**
 * The CMS ratio a picture box of w x h px is nearest, written as the file name prefix ("9-16"), or
 * undefined when the box is not near any (more than 6% off). Width comes first, as in `16-9`.
 */
export function pictureRatio(w: unknown, h: unknown): string | undefined {
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return undefined;
  let best: { name: string; off: number } | undefined;
  for (const [a, b] of RATIOS) {
    const off = Math.abs(Math.log(w / h / (a / b)));
    if (!best || off < best.off) best = { name: `${a}-${b}`, off };
  }
  return best && best.off <= 0.06 ? best.name : undefined;
}

export interface OwnPicture {
  /** The picture's node in each member, the first member's first: the place it is in a card. */
  srcs: string[];
  alt: string;
  /** The CMS ratio of the picture's box in the design ("9-16"), when it is near one. */
  ratio?: string | undefined;
  /** How many different pictures the design gives that place across the members. */
  distinct: number;
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
        ratio: (() => {
          const size = node.props.size as { w?: unknown; h?: unknown } | undefined;
          return pictureRatio(size?.w, size?.h);
        })(),
        distinct: distinct.size,
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
  /** Where the template's bound nodes sit in the first of `items`: [template's src, its own]. */
  fields: Array<[string, string]>;
  /**
   * When every member holds items of the list's shape: each member's share of one flat list, in
   * document order (`[start, end)`), so the rows of a grid draw consecutive items.
   */
  slices?: Array<[string, [number, number]]>;
}

/**
 * A repeat the plan left showing the design's placeholders, beside a sibling of the same shape
 * that it gave data: the page shows real items next to the designer's dummy copy and pictures.
 *
 * The common case is a grid the design draws as rows: two rows of two cards, a list of rows the
 * data does not have (its list is flat). Collapsing the cards of the first row draws every item
 * there and leaves the second row as designed. Only containers count (three pictures layered in
 * a card are not a list), and a repeat with no member given data is the plan leaving it on purpose.
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
    const bound = template
      ? drawn(template)
          .filter((n) => Object.values(n.props).some(hasRef))
          .map((n) => n.src)
      : [];

    const itemsOf = (member: TreeNode) => itemsUnder(member, templateKey, designKids, sk);
    const counts = members.map((m) => itemsOf(m).length);
    let start = 0;
    const slices = counts.every((n) => n > 0)
      ? members.map((m, i): [string, [number, number]] => {
          const share: [number, number] = [start, start + (counts[i] ?? 0)];
          start = share[1];
          return [m.src, share];
        })
      : undefined;

    for (const member of members) {
      const now = appliedBySrc.get(member.src);
      if (!now || drawsData(now)) continue;
      const nodes = subtree(member.id, designKids).flatMap((id) => designById.get(id) ?? []);
      const items = itemsOf(member);
      // node for node, the template and the first item are one shape: their walks line up
      const fields: Array<[string, string]> = [];
      const first = items[0];
      const templateDesign = template ? designBySrc.get(template.src) : undefined;
      if (first && templateDesign) {
        const a = subtree(templateDesign.id, designKids);
        const b = subtree(first.id, designKids);
        a.forEach((id, i) => {
          const from = designById.get(id);
          const to = designById.get(b[i] ?? "");
          if (from && to && bound.includes(from.src)) fields.push([from.src, to.src]);
        });
      }
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
        fields,
        ...(slices ? { slices } : {}),
      });
    }
  }
  return out;
}

function sliceOf(list: unknown[], props: Record<string, unknown>): unknown[] {
  if (Array.isArray(props.slice)) return list.slice(Number(props.slice[0]), Number(props.slice[1]));
  if (typeof props.limit === "number") return list.slice(0, props.limit);
  return list;
}
