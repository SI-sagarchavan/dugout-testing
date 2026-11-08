/**
 * A section's data as its shape, never its values: which fields it shows, of what type, and which
 * lists, with how many items the design draws. Read from the binding plan data-bind applied to a
 * preview (`agents/data-bind/src/tools.ts` `Plan`) and the data it bound, so another tenant can
 * fill the same design with its own data, and a search can name the data a section shows.
 *
 * PURE.
 */

/** What a field holds, by what the design does with it and the value it was bound to. */
export type FieldType = "text" | "number" | "datetime" | "image" | "link" | "boolean" | "unknown";

export interface ShapeField {
  /** From the item for a list's field (`title`), from the top of the data otherwise. */
  path: string;
  type: FieldType;
  /** How the design formats it: `date:"DD MMM, YYYY"`. */
  format?: string;
}

export interface ShapeList {
  /** `news.articles`; a list inside a list's item is `days[].matches`. */
  path: string;
  /** How many items the design draws. */
  items: number;
  /** Each item's fields. */
  fields: ShapeField[];
  /** How many looks an item has: more than 1 when the design draws some items differently. */
  looks: number;
}

export interface DataShape {
  lists: ShapeList[];
  /** Fields outside any list. */
  fields: ShapeField[];
}

/** The part of data-bind's `Plan` read here. Structural, so the agent's own type is passed as is. */
export interface BindingPlan {
  bind?: PlanField[];
  collapse?: Array<{
    over: string;
    as: string;
    members: string[];
    slice?: [number, number];
    fields?: PlanField[];
    variants?: Array<{ src: string; fields?: PlanField[] }>;
  }>;
}

interface PlanField {
  src: string;
  prop: string;
  path?: string;
  template?: string;
}

/** One value the plan binds: where, to which layer, as what. */
interface Bound {
  src: string;
  prop: string;
  /** From the top of the data, `[]` for any item: `news.articles[].title`. */
  path: string;
  /** The same path to one real item, to read its value's type: `news.articles.1.title`. */
  sample: string;
  format?: string;
}

const ITEM = "[]";

/**
 * The shape of what `plan` binds inside a section: `within` says whether a layer (a plan's `src`)
 * is in it. Undefined when nothing in the section is bound.
 */
export function dataShapeOf(opts: {
  plan: BindingPlan;
  data: unknown;
  within: (src: string) => boolean;
}): DataShape | undefined {
  const { plan, data, within } = opts;
  const bound: Bound[] = [];
  /** Items drawn, by list path. */
  const drawn = new Map<string, number>();
  /** Looks an item has, by list path. */
  const looks = new Map<string, number>();
  const draws = (list: string, items: number) =>
    drawn.set(list, Math.max(drawn.get(list) ?? 0, items));

  /** Lists' items by the alias the plan names them with, as each collapse is read. */
  const aliases = new Map<string, { path: string; sample: string }>();
  const add = (f: PlanField, item: { path: string; sample: string } | undefined) => {
    const refs = f.path ? [f.path] : refsOf(f.template ?? "");
    for (const ref of refs) {
      const { path, format } = splitPipe(ref);
      // a field's path starts at the item; a template's ref names an item's alias first, or
      // starts at the top of the data
      let base = f.template ? undefined : item;
      let rel = path;
      if (f.template) {
        const [head = "", ...rest] = path.split(".");
        const named = aliases.get(head);
        if (named) {
          base = named;
          rel = rest.join(".");
        }
      }
      const joined = base
        ? { path: `${base.path}.${rel}`, sample: `${base.sample}.${rel}` }
        : { path: rel, sample: rel };
      const norm = normalise(joined.path);
      for (const [list, index] of norm.positions) draws(list, index + 1);
      bound.push({
        src: f.src,
        prop: f.prop,
        path: norm.path,
        sample: joined.sample,
        ...(format ? { format } : {}),
      });
    }
  };

  for (const f of plan.bind ?? []) if (within(f.src)) add(f, undefined);

  // lists, innermost first in the plan: an outer alias resolves once its own collapse is read
  const collapses = [...(plan.collapse ?? [])].reverse();
  for (const c of collapses) {
    const [head, ...rest] = c.over.split(".");
    const outer = head ? aliases.get(head) : undefined;
    const over = outer
      ? { path: [outer.path, ...rest].join("."), sample: [outer.sample, ...rest].join(".") }
      : { path: normalise(c.over).path, sample: c.over };
    const start = c.slice?.[0] ?? 0;
    const item = { path: `${over.path}${ITEM}`, sample: `${over.sample}.${start}` };
    aliases.set(c.as, item);
    if (!c.members.some(within)) continue;
    draws(over.path, c.slice ? c.slice[1] : c.members.length);
    if (c.variants?.length)
      looks.set(over.path, Math.max(looks.get(over.path) ?? 1, 1 + c.variants.length));
    for (const f of c.fields ?? []) add(f, item);
    for (const v of c.variants ?? []) for (const f of v.fields ?? []) add(f, item);
  }
  if (!bound.length) return undefined;

  const lists = new Map<string, ShapeList>();
  const fields: ShapeField[] = [];
  const seen = new Set<string>();
  for (const b of bound) {
    if (seen.has(b.path)) continue;
    seen.add(b.path);
    const field = (path: string): ShapeField => ({
      path,
      type: typeOf(valueAt(data, b.sample), b.prop, b.format),
      ...(b.format ? { format: b.format } : {}),
    });
    const at = b.path.lastIndexOf(`${ITEM}.`);
    if (at < 0) {
      fields.push(field(b.path));
      continue;
    }
    const listPath = b.path.slice(0, at);
    let list = lists.get(listPath);
    if (!list) {
      list = {
        path: listPath,
        items: drawn.get(listPath) ?? 1,
        fields: [],
        looks: looks.get(listPath) ?? 1,
      };
      lists.set(listPath, list);
    }
    list.fields.push(field(b.path.slice(at + ITEM.length + 1)));
  }
  return { lists: [...lists.values()], fields };
}

/** `news.articles.0.title` → `news.articles[].title`, with the index each list is read at. */
function normalise(path: string): { path: string; positions: Array<[string, number]> } {
  const out: string[] = [];
  const positions: Array<[string, number]> = [];
  for (const seg of path.split(".")) {
    if (/^\d+$/.test(seg) && out.length) {
      const list = out.join(".");
      positions.push([list, Number(seg)]);
      out[out.length - 1] = `${out[out.length - 1]}${ITEM}`;
    } else {
      out.push(seg);
    }
  }
  return { path: out.join("."), positions };
}

/** `published_date | date:"DD MMM"` → the path and the pipe. */
function splitPipe(ref: string): { path: string; format?: string } {
  const [path = "", ...pipes] = ref.split("|").map((s) => s.trim());
  const format = pipes.join(" | ");
  return format ? { path, format } : { path };
}

/** The refs in a template: `({match.overs} ov)` → `match.overs`. */
function refsOf(template: string): string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

function valueAt(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const seg of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function typeOf(value: unknown, prop: string, format?: string): FieldType {
  if (format && /^date\b/.test(format)) return "datetime";
  if (prop === "src") return "image";
  if (prop === "href" || prop === "link") return "link";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return "unknown";
  if (ISO_DATE.test(value)) return "datetime";
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return "number";
  if (/^https?:\/\//.test(value) && /\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(value)) {
    return "image";
  }
  return "text";
}

const TYPE_WORDS: Record<FieldType, string> = {
  text: "text",
  number: "number",
  datetime: "date",
  image: "picture",
  link: "link",
  boolean: "yes or no",
  unknown: "",
};

/** A path's last part as words: `published_date` → `published date`. */
const words = (path: string) =>
  (path.split(".").pop() ?? path)
    .replace(ITEM, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

const fieldWords = (f: ShapeField) => {
  const t = TYPE_WORDS[f.type];
  const name = words(f.path);
  return t && t !== name ? `${name} (${t})` : name;
};

/**
 * The shape in words, for the text a search reads: "Data: a list of 5 news articles, each with
 * image (picture), title (text), published date (date)."
 */
export function shapeWords(shape: DataShape): string {
  const parts = shape.lists.map((l) => {
    const name = l.path
      .split(".")
      .map((s) => words(s))
      .join(" ");
    const looks = l.looks > 1 ? ` in ${l.looks} looks` : "";
    return `a list of ${l.items} ${name}${looks}, each with ${l.fields.map(fieldWords).join(", ")}`;
  });
  if (shape.fields.length) parts.push(`fields ${shape.fields.map(fieldWords).join(", ")}`);
  return parts.length ? `Data: ${parts.join("; ")}.` : "";
}
