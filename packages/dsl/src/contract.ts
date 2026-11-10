/**
 * Bindings against the data they will meet — the B rules.
 *
 * The S and T rules check a tree against the vocabulary and the theme. These
 * check it against a DATA SAMPLE: every `{path}`, every `Repeater.over`, every
 * `when` must name something the payload has, in a shape that slot can draw.
 *
 * Why it has to be static: a wrong path is schema-legal and geometry-neutral.
 * `{article.headline}` against a CMS Listing payload (whose field is `title`)
 * validates, conforms, and renders the literal braces onto the page. The
 * renderer can only warn after the fact; an agent repairing the tree needs to
 * hear it before, with the fields it COULD have used.
 *
 * THE SAMPLE IS THE CONTRACT, until CAST hands us the hook's output schema.
 * Every item of every list is merged, so a field that is null on the first
 * article and set on the third is known, and known to be nullable. A field no
 * sampled item carries is invisible to this — B1 on it may be a short sample,
 * not a wrong tree.
 *
 *   B1  path not in the data
 *   B2  wrong shape for the slot (an object drawn as text, `over` not a list)
 *   B3  path walks through a numeric page key (`data.1`) — bind `items`
 *   B4  unknown pipe, wrong arity, or `date` on a value that is not a date
 *   B5  an ISO date drawn without `date` — it will print `2026-10-21T10:29:00.000Z`
 *   B6  image URL has the CDN `{{RATIO}}` slot and the Image has no (servable) ratio
 *   B7  `when` compares against a value of a type the field never holds
 *
 * PURE.
 */

import { clockAlias, clockSchema, clockUnits } from "./clock.js";
import type { FlatNode, FlatTree } from "./flat.js";
import { isPagePath, overChoice, selectOf } from "./page.js";
import type { Issue } from "./validate.js";
import {
  brokenRefs,
  CDN_RATIOS,
  choiceValue,
  conditionsOf,
  parseRefs,
  PIPES,
  predicateSchema,
  readDate,
  RATIO_SLOT,
  type Ref,
} from "./binding.js";

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------

type ScalarType = "string" | "number" | "boolean" | "null";

export type Shape =
  | {
      kind: "scalar";
      types: Set<ScalarType>;
      /** Every string sample is an ISO timestamp: drawn raw, it prints `2026-10-21T10:29:00.000Z` (B5). */
      isoDate: boolean;
      /** How many samples the `date` pipe reads (`readDate`: any form it takes, numbers too). */
      dates: number;
      /** Strings it cannot read as a date, a few of them: drawn with `date`, they draw nothing. */
      undated: string[];
      ratioSlot: boolean;
    }
  | { kind: "object"; fields: Map<string, Shape>; nullable: boolean }
  | { kind: "array"; of: Shape | null; nullable: boolean };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UNDATED_MAX = 3;

/** What a clock puts in scope: the units it draws, `past` and `total`. */
function clockShape(units: readonly string[]): Shape {
  const num = (): Shape => ({ kind: "scalar", types: new Set<ScalarType>(["number"]), isoDate: false, dates: 0, undated: [], ratioSlot: false });
  const fields = new Map<string, Shape>(units.map((unit) => [unit, num()]));
  fields.set("total", num());
  fields.set("past", { kind: "scalar", types: new Set<ScalarType>(["boolean"]), isoDate: false, dates: 0, undated: [], ratioSlot: false });
  return { kind: "object", fields, nullable: false };
}

/** The merged shape of a sample. Arrays merge every element. */
export function inferShape(value: unknown): Shape {
  if (Array.isArray(value)) {
    let of: Shape | null = null;
    for (const el of value) of = of ? mergeShape(of, inferShape(el)) : inferShape(el);
    return { kind: "array", of, nullable: false };
  }
  if (value !== null && typeof value === "object") {
    const fields = new Map<string, Shape>();
    for (const [k, v] of Object.entries(value)) fields.set(k, inferShape(v));
    return { kind: "object", fields, nullable: false };
  }
  const t: ScalarType = value === null ? "null" : (typeof value as ScalarType);
  const read = (typeof value === "string" && value.trim() !== "") || typeof value === "number" ? readDate(value) : undefined;
  return {
    kind: "scalar",
    types: new Set([t]),
    isoDate: typeof value === "string" && ISO_DATE_RE.test(value),
    dates: read === undefined ? 0 : 1,
    undated: typeof value === "string" && value.trim() !== "" && read === undefined ? [value] : [],
    ratioSlot: typeof value === "string" && value.includes(RATIO_SLOT),
  };
}

function mergeShape(a: Shape, b: Shape): Shape {
  // `null` beside a structure is a nullable structure, not a type conflict.
  if (isNullScalar(a) && b.kind !== "scalar") return { ...b, nullable: true };
  if (isNullScalar(b) && a.kind !== "scalar") return { ...a, nullable: true };

  if (a.kind === "scalar" && b.kind === "scalar") {
    const types = new Set([...a.types, ...b.types]);
    // A date column stays a date column through its nulls.
    const isoDate = (a.isoDate || isNullScalar(a)) && (b.isoDate || isNullScalar(b)) && (a.isoDate || b.isoDate);
    const undated = [...new Set([...a.undated, ...b.undated])].slice(0, UNDATED_MAX);
    return { kind: "scalar", types, isoDate, dates: a.dates + b.dates, undated, ratioSlot: a.ratioSlot || b.ratioSlot };
  }
  if (a.kind === "object" && b.kind === "object") {
    const fields = new Map(a.fields);
    for (const [k, v] of b.fields) fields.set(k, fields.has(k) ? mergeShape(fields.get(k)!, v) : v);
    return { kind: "object", fields, nullable: a.nullable || b.nullable };
  }
  if (a.kind === "array" && b.kind === "array") {
    const of = a.of && b.of ? mergeShape(a.of, b.of) : (a.of ?? b.of);
    return { kind: "array", of, nullable: a.nullable || b.nullable };
  }
  return a; // genuinely mixed; keep the first and let the checks speak for it
}

const isNullScalar = (s: Shape): boolean => s.kind === "scalar" && s.types.size === 1 && s.types.has("null");

type Walk =
  | { ok: true; shape: Shape; pageKey?: string }
  | { ok: false; at: string; parent: Shape | null; pageKey?: string };

/** Follow a dotted path through a shape, remembering where it stopped. */
function walkShape(scope: Shape, path: string): Walk {
  let cur: Shape = scope;
  let pageKey: string | undefined;
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const at = parts.slice(0, i + 1).join(".");
    if (cur.kind === "array" && /^\d+$/.test(part)) {
      if (!cur.of) return { ok: false, at, parent: cur, ...(pageKey ? { pageKey } : {}) };
      cur = cur.of;
      continue;
    }
    if (cur.kind !== "object") return { ok: false, at, parent: cur, ...(pageKey ? { pageKey } : {}) };
    const next = cur.fields.get(part);
    if (/^\d+$/.test(part) && next?.kind === "array") pageKey ??= at;
    if (!next) return { ok: false, at, parent: cur, ...(pageKey ? { pageKey } : {}) };
    cur = next;
  }
  return { ok: true, shape: cur, ...(pageKey ? { pageKey } : {}) };
}

/**
 * What an object offers, for the B1 message — the menu the agent picks from.
 *
 * All of it, up to a generous cap. A CMS Listing item has 21 fields and `title`
 * is the 14th, so a short menu hides exactly the field a `{headline}` binding
 * was reaching for.
 */
const MENU_MAX = 40;
function offered(shape: Shape | null): string {
  if (!shape || shape.kind !== "object") return "";
  const keys = [...shape.fields.keys()];
  const shown = keys.slice(0, MENU_MAX).join(", ");
  return ` — it has ${shown}${keys.length > MENU_MAX ? `, … (${keys.length} fields)` : ""}`;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Every string in a props bag that carries a ref, with its dotted prop path. */
function templatesIn(props: Record<string, unknown>): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (v.includes("{")) out.push({ prop: path, value: v });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}.${i}`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  for (const [k, v] of Object.entries(props)) {
    // `when` and `over` are paths, not templates — checked on their own below.
    if (k === "_meta" || k === "when") continue;
    // an `over` that follows a page choice (`squad.{_page.squad}`) names the choice, not a ref
    if (k === "over" && typeof v === "string" && overChoice(v)) continue;
    walk(v, k);
  }
  return out;
}

/** Pipe checks need no data, so they run on every validate. */
export function checkPipes(tree: FlatTree): Issue[] {
  const issues: Issue[] = [];
  for (const node of tree.nodes) {
    for (const t of templatesIn(node.props)) {
      for (const span of brokenRefs(t.value)) {
        issues.push({
          code: "B4",
          severity: "error",
          nodeId: node.id,
          path: t.prop,
          message: `${span}: not a ref the renderer reads, so the page draws it as written — a ref is {path} or {path | pipe:"arg"}, the pipes are ${Object.keys(PIPES).join(", ")}; a label for each code (R → RECENT) is a variant with a when for each value, or a field the data gives`,
        });
      }
      for (const ref of parseRefs(t.value)) {
        for (const pipe of ref.pipes) {
          const spec = PIPES[pipe.name];
          if (!spec) {
            issues.push({
              code: "B4",
              severity: "error",
              nodeId: node.id,
              path: t.prop,
              message: `${ref.text}: unknown pipe "${pipe.name}" — the pipes are ${Object.keys(PIPES).join(", ")}`,
            });
          } else if (!spec.arity.includes(pipe.args.length)) {
            issues.push({
              code: "B4",
              severity: "error",
              nodeId: node.id,
              path: t.prop,
              message: `${ref.text}: "${pipe.name}" takes ${spec.arity.join(" or ")} argument(s), got ${pipe.args.length} — ${spec.doc}`,
            });
          }
        }
      }
    }
  }
  return issues;
}

/**
 * Check every binding in the tree against a data sample.
 *
 * Scopes follow the Repeaters: inside `Repeater{over: "news.items", as: "article"}`
 * the name `article` is one merged item of `news.items`.
 */
export interface BindingCheckOptions {
  /**
   * The page choices other sections of the page write (frame-match's `page_choices`): an `over`
   * that reads one checks its options too, beside those this tree writes.
   */
  choices?: ReadonlyArray<{ key: string; options: ReadonlyArray<{ value: string }> }>;
}

export function checkBindings(tree: FlatTree, data: unknown, options: BindingCheckOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (issue: Issue) => issues.push(issue);
  const root = inferShape(data);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const scopes = new Map<string, Shape>();

  /** The scope a node's OWN props see — its parent's, plus the alias if the parent repeats. */
  const scopeOf = (node: FlatNode): Shape => {
    const hit = scopes.get(node.id);
    if (hit) return hit;
    const parent = node.parent === null ? undefined : byId.get(node.parent);
    let scope = parent ? scopeOf(parent) : root;
    if (parent?.type === "Repeater") {
      const over = String(parent.props.over ?? "");
      const as = String(parent.props.as ?? "");
      // a list that follows a page choice: an item is an item of any of its lists
      const item = overChoice(over)
        ? choiceLists(scope, over).lists.reduce<Shape | null>((a, l) => (a && l.of ? mergeShape(a, l.of) : (a ?? l.of)), null)
        : (() => {
            const list = walkShape(scope, over);
            return list.ok && list.shape.kind === "array" ? list.shape.of : null;
          })();
      if (as && item && scope.kind === "object") {
        scope = { ...scope, fields: new Map(scope.fields).set(as, item) };
      }
    }
    // a clock's values are in scope on the node that carries it, and under it
    const clock = clockSchema.safeParse(node.props.clock);
    if (clock.success && scope.kind === "object") {
      scope = { ...scope, fields: new Map(scope.fields).set(clockAlias(clock.data), clockShape(clockUnits(clock.data))) };
    }
    scopes.set(node.id, scope);
    return scope;
  };

  const missing = (node: FlatNode, prop: string, label: string, path: string, w: Walk & { ok: false }) => {
    const head = path.split(".")[0]!;
    const where = w.at === head ? `no "${head}" in scope` : `"${w.at.split(".").slice(0, -1).join(".")}" has no "${w.at.split(".").pop()}"`;
    add({
      code: "B1",
      severity: "error",
      nodeId: node.id,
      path: prop,
      message: `${label}: ${where}${offered(w.parent)}`,
    });
  };

  const pageKey = (node: FlatNode, prop: string, label: string, key: string) =>
    add({
      code: "B3",
      severity: "warning",
      nodeId: node.id,
      path: prop,
      message: `${label} walks through "${key}" — a CAST flow keys its items by PAGE number, so this draws page ${key.split(".").pop()} and nothing else. Normalise the response (fromCastFlow) and bind "items".`,
    });

  for (const node of tree.nodes) {
    const scope = scopeOf(node);

    // --- refs in templates ----------------------------------------------
    for (const t of templatesIn(node.props)) {
      for (const ref of parseRefs(t.value)) {
        const w = walkShape(scope, ref.path);
        if (w.pageKey) pageKey(node, t.prop, ref.text, w.pageKey);
        if (!w.ok) {
          if (!ref.pipes.some((p) => p.name === "default")) missing(node, t.prop, ref.text, ref.path, w);
          continue;
        }
        // a clock counts to the instant: it is read, never drawn
        if (t.prop === "clock.to") {
          if (w.shape.kind !== "scalar" || w.shape.dates === 0) {
            add({
              code: "B4",
              severity: "warning",
              nodeId: node.id,
              path: t.prop,
              message: `clock.to ${ref.text}: the sample values are not dates or times the clock can read`,
            });
          } else if (w.shape.undated.length > 0) {
            add({
              code: "B4",
              severity: "warning",
              nodeId: node.id,
              path: t.prop,
              message: `clock.to ${ref.text}: some sample values cannot be read as a date (${w.shape.undated.map((v) => JSON.stringify(v)).join(", ")}) — the clock is not drawn for them`,
            });
          }
          continue;
        }
        checkRef(node, t.prop, ref, w.shape, add);
      }
    }

    // --- Repeater.over --------------------------------------------------
    if (node.type === "Repeater" && typeof node.props.over === "string" && overChoice(node.props.over)) {
      // a list that follows a page choice: the data's lists are its options, whichever section
      // writes the choice; an option known here that names none draws every list (an ALL option)
      const over = node.props.over;
      const key = overChoice(over) as string;
      const { lists, parent, at, before } = choiceLists(scope, over);
      if (lists.length === 0) {
        add({
          code: "B2",
          severity: "error",
          nodeId: node.id,
          path: "over",
          message: at
            ? `over "${over}" reads the page choice "${key}": "${at}" is not in the data${offered(parent)}`
            : `over "${over}" reads the page choice "${key}", but ${before ? `"${before}"` : "the data"} holds no list under any key — one list per option goes there${offered(parent)}`,
        });
      } else {
        const known = new Map<string, string>();
        for (const n of tree.nodes) {
          const select = selectOf(n);
          if (select?.key === key) known.set(choiceValue(select.value), select.value);
        }
        for (const c of options.choices ?? []) {
          if (c.key !== key) continue;
          for (const o of c.options) if (!known.has(choiceValue(o.value))) known.set(choiceValue(o.value), o.value);
        }
        const names = new Set(lists.map((l) => choiceValue(l.name)));
        for (const [norm, option] of known) {
          if (names.has(norm)) continue;
          add({
            code: "B2",
            severity: "warning",
            nodeId: node.id,
            path: "over",
            message: `over "${over}": the option "${option}" names no list (the lists are ${lists.map((l) => l.name).join(", ")}), so it draws every list's items, as an ALL option does — if it is not one, its list is missing from the data`,
          });
        }
      }
    } else if (node.type === "Repeater" && typeof node.props.over === "string") {
      const over = node.props.over;
      const w = walkShape(scope, over);
      if (w.pageKey) pageKey(node, "over", `over "${over}"`, w.pageKey);
      if (!w.ok) missing(node, "over", `over "${over}"`, over, w);
      else if (w.shape.kind !== "array") {
        add({
          code: "B2",
          severity: "error",
          nodeId: node.id,
          path: "over",
          message: `over "${over}" is ${describe(w.shape)}, not a list${w.shape.kind === "object" && w.shape.fields.has("items") ? ` — did you mean "${over}.items"?` : ""}`,
        });
      }
    }

    // --- when -----------------------------------------------------------
    const parsed = node.props.when === undefined ? undefined : predicateSchema.safeParse(node.props.when);
    if (parsed?.success) {
      for (const c of conditionsOf(parsed.data)) {
        // the page's choices are another section's to write, so they are never in this data
        if (c.eqPath !== undefined && !isPagePath(c.eqPath)) {
          const other = walkShape(scope, c.eqPath);
          if (!other.ok) missing(node, "when", `when "${c.eqPath}"`, c.eqPath, other);
        }
        if (isPagePath(c.path)) continue;
        const w = walkShape(scope, c.path);
        if (!w.ok) {
          missing(node, "when", `when "${c.path}"`, c.path, w);
          continue;
        }
        const compared = c.eq !== undefined ? [c.eq] : c.ne !== undefined ? [c.ne] : (c.in ?? []);
        const holds = w.shape.kind === "scalar" ? w.shape.types : null;
        const strays = holds
          ? compared.filter((v) => !holds.has(v === null ? "null" : (typeof v as ScalarType)))
          : [];
        if (strays.length > 0) {
          add({
            code: "B7",
            severity: "warning",
            nodeId: node.id,
            path: "when",
            message: `when "${c.path}" compares against ${strays.map((s) => JSON.stringify(s)).join(", ")}, but the field only holds ${[...holds!].join(" | ")} — strict equality will never match`,
          });
        }
      }
    }
  }
  return issues;

  function checkRef(node: FlatNode, prop: string, ref: Ref, shape: Shape, add: (i: Issue) => void): void {
    if (shape.kind !== "scalar") {
      add({
        code: "B2",
        severity: "error",
        nodeId: node.id,
        path: prop,
        message: `${ref.text} is ${describe(shape)} — a template draws text; bind one of its fields${offered(shape)}`,
      });
      return;
    }
    const dated = ref.pipes.some((p) => p.name === "date");
    if (dated && shape.dates === 0) {
      add({
        code: "B4",
        severity: "warning",
        nodeId: node.id,
        path: prop,
        message: `${ref.text}: "date" on a field whose sample values are not dates${shape.undated.length ? ` (${shape.undated.map((v) => JSON.stringify(v)).join(", ")})` : ""}`,
      });
    } else if (dated && shape.undated.length > 0) {
      add({
        code: "B4",
        severity: "warning",
        nodeId: node.id,
        path: prop,
        message: `${ref.text}: some sample values cannot be read as a date (${shape.undated.map((v) => JSON.stringify(v)).join(", ")}) — "date" draws nothing for them; add a default pipe, or mend them in the hook`,
      });
    }
    if (!dated && shape.isoDate) {
      add({
        code: "B5",
        severity: "warning",
        nodeId: node.id,
        path: prop,
        message: `${ref.text} is an ISO timestamp drawn raw — add a pipe, e.g. {${ref.path} | date:"MMM DD, YYYY"}`,
      });
    }
    if (node.type === "Image" && prop === "src" && shape.ratioSlot) {
      const ratio = typeof node.props.ratio === "string" ? node.props.ratio.replace(/\s/g, "") : undefined;
      if (!ratio) {
        add({
          code: "B6",
          severity: "warning",
          nodeId: node.id,
          path: "ratio",
          message: `${ref.text} has the CDN ${RATIO_SLOT} slot and this Image has no ratio, so the CDN serves its 16:9 default whatever the box is — set ratio to the box's aspect (${CDN_RATIOS.join(", ")})`,
        });
      } else if (!(CDN_RATIOS as readonly string[]).includes(ratio)) {
        add({
          code: "B6",
          severity: "error",
          nodeId: node.id,
          path: "ratio",
          message: `ratio "${ratio}" is not a crop the media CDN serves — it answers 200 with a 1×1 pixel. Use one of ${CDN_RATIOS.join(", ")}`,
        });
      }
    }
  }
}

function describe(shape: Shape): string {
  if (shape.kind === "array") return "a list";
  if (shape.kind === "object") return "an object";
  return [...shape.types].join(" | ");
}

/**
 * The lists an `over` that reads a page choice can draw, as shapes: each key under the part before
 * the choice whose value (and the part after it) is a list, keys that normalise alike as one. As
 * `overLists` in `page.ts` reads them from data, here from the merged sample in the Repeater's own
 * scope (an item's, inside another Repeater). A key is one segment, dots and all.
 */
function choiceLists(
  scope: Shape,
  over: string,
): { lists: Array<{ name: string; of: Shape | null }>; parent: Shape | null; before: string; at?: string } {
  const key = overChoice(over) as string;
  const token = `{_page.${key}}`;
  const before = over.slice(0, over.indexOf(token)).replace(/\.$/, "");
  const after = over.slice(over.indexOf(token) + token.length).replace(/^\./, "");
  const walked = before ? walkShape(scope, before) : ({ ok: true, shape: scope } as const);
  if (!walked.ok) return { lists: [], parent: walked.parent, before, at: walked.at };
  const parent = walked.shape;
  if (parent.kind !== "object") return { lists: [], parent, before };
  const seen = new Set<string>();
  const lists: Array<{ name: string; of: Shape | null }> = [];
  for (const [name, field] of parent.fields) {
    if (name.startsWith("_")) continue;
    const list = after ? walkShape(field, after) : ({ ok: true, shape: field } as const);
    const norm = choiceValue(name);
    if (!list.ok || list.shape.kind !== "array" || seen.has(norm)) continue;
    seen.add(norm);
    lists.push({ name, of: list.shape.of });
  }
  return { lists, parent, before };
}
