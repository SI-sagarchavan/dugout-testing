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
  repeats: Array<{ template: string; over: string; items: number }>;
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
  const repeated = new Map<string, DryRun["repeated"][number]>();
  const root = tree.nodes.find((n) => n.parent === null);
  const repeats = new Map<string, { over: string; items: number }>();
  const unresolved = new Map<string, DryRun["unresolved"][number]>();
  const variants = new Map<string, DryRun["variants"][number]>();
  const samples = new Map<string, DryRun["samples"][number]>();

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
      const children = kids.get(node.id) ?? [];
      const template = children[0]?.src ?? node.src;
      const items = Array.isArray(list) ? sliceOf(list, node.props) : [];
      const r = repeats.get(template) ?? { over, items: 0 };
      r.items += items.length;
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
    capitals: [...capitals.values()],
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
export function lostLooks(tree: Tree, members: string[]): string[] {
  const kids = childrenOf(tree);
  const sk = skeletons(tree);
  const bySrc = new Map(tree.nodes.map((node) => [node.src, node]));
  const template = bySrc.get(members[0] ?? "");
  if (!template) return [];
  const found: string[] = [];
  const compare = (a: TreeNode, b: TreeNode) => {
    for (const prop of LOOK) {
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

function sliceOf(list: unknown[], props: Record<string, unknown>): unknown[] {
  if (Array.isArray(props.slice)) return list.slice(Number(props.slice[0]), Number(props.slice[1]));
  if (typeof props.limit === "number") return list.slice(0, props.limit);
  return list;
}
