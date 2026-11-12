/**
 * The expression language of a section's machine: guards, `assign`, `computed`, `exports`, a
 * request's input. JSON, closed, synchronous, with no access to anything but the scope it is given.
 *
 * An expression is one of:
 *
 *   a scalar                       "open", 3, true, null
 *   a list                         [e, e, ...]  each element an expression
 *   an op                          { "<op>": [args] } or { "<op>": arg }   exactly one key, a known op
 *
 * A plain object is never a literal: build one with `{ "obj": { "k": e } }`, or quote any JSON with
 * `{ "lit": ... }`. An object with an unknown key is an error, not a literal, so a typo in an op is
 * caught by the validator instead of evaluating to itself.
 *
 *   { "var": "context.items" }                 a path in the scope ([path, default] for a default)
 *   { "+": [{ "var": "context.count" }, 1] }
 *   { "filter": [{ "var": "context.items" }, { "!=": [{ "var": "it.id" }, { "var": "event.id" }] }] }
 *   { "sum": [{ "var": "context.lines" }, { "*": [{ "var": "it.qty" }, { "var": "it.price" }] }] }
 *
 * Inside `map`, `filter`, `find`, `some`, `every`, `sum`, `count`, `sort`, `updateWhere` and
 * `removeWhere`, the item is `it` and its position `index`; inside `reduce` the running value is
 * `acc` too. A lambda's scope is the outer one plus those, so a guard can compare the item with the
 * event.
 *
 * Shaped like JsonLogic on purpose (the model writes it well), with our own op set. Every value is
 * JSON in and JSON out; nothing is mutated (`set`, `append`, `remove` return new values), so a
 * snapshot is never changed behind the interpreter's back. Each evaluation has a step budget, so a
 * runaway expression throws instead of hanging a page.
 *
 * PURE.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Expr = unknown;

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

/** Path segments no expression may read: the way out of plain data. */
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** How many op evaluations one call may take. */
const STEP_BUDGET = 50_000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Read a dotted path; a numeric segment indexes a list. Undefined when anything on the way is missing. */
export function readPath(scope: unknown, path: string): unknown {
  if (path === "") return scope;
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (FORBIDDEN.has(part)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (part === "length") {
        cur = cur.length;
        continue;
      }
      const i = Number(part);
      cur = Number.isInteger(i) ? cur[i < 0 ? cur.length + i : i] : undefined;
      continue;
    }
    if (!Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A copy of `target` with `value` at `path` (dotted; numeric segments index lists). */
export function writePath(target: unknown, path: string, value: unknown): unknown {
  const [head, ...rest] = path.split(".");
  if (head === undefined || head === "") return value;
  if (FORBIDDEN.has(head)) throw new ExprError(`"${head}" cannot be written`);
  const next = rest.length ? writePath(readPath(target, head), rest.join("."), value) : value;
  if (Array.isArray(target) && /^\d+$/.test(head)) {
    const copy = target.slice();
    copy[Number(head)] = next;
    return copy;
  }
  const base = isObj(target) ? target : {};
  return { ...base, [head]: next };
}

/** Structural equality over JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const truthy = (v: unknown): boolean =>
  !(v === false || v === null || v === undefined || v === 0 || v === "" || (Array.isArray(v) && v.length === 0));

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** What an op may be given: its args unevaluated, so lambdas see each item. */
type OpFn = (args: unknown[], scope: Scope, ev: Evaluator) => unknown;

interface Evaluator {
  (expr: Expr, scope: Scope): unknown;
}

type Scope = Record<string, unknown>;

const withItem = (scope: Scope, it: unknown, index: number, extra: Scope = {}): Scope => ({ ...scope, it, index, ...extra });

/** Compare for sorting: numbers as numbers, the rest as strings, missing last. */
function compare(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return str(a).localeCompare(str(b));
}

const lambda =
  (fn: (items: unknown[], body: Expr, scope: Scope, ev: Evaluator, rest: unknown[]) => unknown): OpFn =>
  (args, scope, ev) =>
    fn(list(ev(args[0], scope)), args[1], scope, ev, args.slice(2));

const OPS: Record<string, OpFn> = {
  // --- reading ------------------------------------------------------------
  var: (args, scope, ev) => {
    const path = ev(args[0], scope);
    const found = readPath(scope, typeof path === "number" ? String(path) : str(path));
    return found === undefined && args.length > 1 ? ev(args[1], scope) : found;
  },
  lit: (args) => args[0],
  obj: (args, scope, ev) => {
    const shape = args[0];
    if (!isObj(shape)) throw new ExprError("obj takes an object of expressions");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(shape)) {
      if (FORBIDDEN.has(k)) throw new ExprError(`"${k}" cannot be a key`);
      out[k] = ev(v, scope);
    }
    return out;
  },

  // --- logic --------------------------------------------------------------
  "==": (a, s, ev) => deepEqual(ev(a[0], s), ev(a[1], s)),
  "!=": (a, s, ev) => !deepEqual(ev(a[0], s), ev(a[1], s)),
  "<": (a, s, ev) => num(ev(a[0], s)) < num(ev(a[1], s)),
  "<=": (a, s, ev) => num(ev(a[0], s)) <= num(ev(a[1], s)),
  ">": (a, s, ev) => num(ev(a[0], s)) > num(ev(a[1], s)),
  ">=": (a, s, ev) => num(ev(a[0], s)) >= num(ev(a[1], s)),
  and: (a, s, ev) => {
    let last: unknown = true;
    for (const x of a) {
      last = ev(x, s);
      if (!truthy(last)) return false;
    }
    return truthy(last);
  },
  or: (a, s, ev) => a.some((x) => truthy(ev(x, s))),
  not: (a, s, ev) => !truthy(ev(a[0], s)),
  bool: (a, s, ev) => truthy(ev(a[0], s)),
  /** [cond, then, cond2, then2, ..., else] */
  if: (a, s, ev) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (truthy(ev(a[i], s))) return ev(a[i + 1], s);
    return a.length % 2 === 1 ? ev(a[a.length - 1], s) : null;
  },
  "??": (a, s, ev) => {
    for (const x of a) {
      const v = ev(x, s);
      if (v !== undefined && v !== null) return v;
    }
    return null;
  },
  exists: (a, s, ev) => {
    const v = ev(a[0], s);
    return v !== undefined && v !== null && v !== "";
  },
  isEmpty: (a, s, ev) => !truthy(ev(a[0], s)),

  // --- numbers ------------------------------------------------------------
  "+": (a, s, ev) => a.reduce<number>((t, x) => t + num(ev(x, s)), 0),
  "-": (a, s, ev) => (a.length === 1 ? -num(ev(a[0], s)) : num(ev(a[0], s)) - num(ev(a[1], s))),
  "*": (a, s, ev) => a.reduce<number>((t, x) => t * num(ev(x, s)), 1),
  "/": (a, s, ev) => {
    const d = num(ev(a[1], s));
    return d === 0 ? null : num(ev(a[0], s)) / d;
  },
  "%": (a, s, ev) => {
    const d = num(ev(a[1], s));
    return d === 0 ? null : num(ev(a[0], s)) % d;
  },
  min: (a, s, ev) => {
    const xs = (a.length === 1 ? list(ev(a[0], s)) : a.map((x) => ev(x, s))).map(num);
    return xs.length ? Math.min(...xs) : null;
  },
  max: (a, s, ev) => {
    const xs = (a.length === 1 ? list(ev(a[0], s)) : a.map((x) => ev(x, s))).map(num);
    return xs.length ? Math.max(...xs) : null;
  },
  /** [x, digits?] */
  round: (a, s, ev) => {
    const f = 10 ** num(a.length > 1 ? ev(a[1], s) : 0);
    return Math.round(num(ev(a[0], s)) * f) / f;
  },
  floor: (a, s, ev) => Math.floor(num(ev(a[0], s))),
  ceil: (a, s, ev) => Math.ceil(num(ev(a[0], s))),
  abs: (a, s, ev) => Math.abs(num(ev(a[0], s))),
  /** [x, lo, hi] */
  clamp: (a, s, ev) => Math.min(num(ev(a[2], s)), Math.max(num(ev(a[1], s)), num(ev(a[0], s)))),
  num: (a, s, ev) => num(ev(a[0], s)),

  // --- text ---------------------------------------------------------------
  cat: (a, s, ev) => a.map((x) => str(ev(x, s))).join(""),
  str: (a, s, ev) => str(ev(a[0], s)),
  lower: (a, s, ev) => str(ev(a[0], s)).toLowerCase(),
  upper: (a, s, ev) => str(ev(a[0], s)).toUpperCase(),
  trim: (a, s, ev) => str(ev(a[0], s)).trim(),
  /** [haystack, needle]: a substring, case-insensitive (search boxes) */
  contains: (a, s, ev) => str(ev(a[0], s)).toLowerCase().includes(str(ev(a[1], s)).toLowerCase()),
  startsWith: (a, s, ev) => str(ev(a[0], s)).toLowerCase().startsWith(str(ev(a[1], s)).toLowerCase()),
  /** [list|string|object] */
  len: (a, s, ev) => {
    const v = ev(a[0], s);
    if (Array.isArray(v) || typeof v === "string") return v.length;
    if (isObj(v)) return Object.keys(v).length;
    return 0;
  },

  // --- lists --------------------------------------------------------------
  includes: (a, s, ev) => {
    const v = ev(a[1], s);
    return list(ev(a[0], s)).some((x) => deepEqual(x, v));
  },
  indexOf: (a, s, ev) => {
    const v = ev(a[1], s);
    return list(ev(a[0], s)).findIndex((x) => deepEqual(x, v));
  },
  first: (a, s, ev) => list(ev(a[0], s))[0] ?? null,
  last: (a, s, ev) => {
    const xs = list(ev(a[0], s));
    return xs[xs.length - 1] ?? null;
  },
  at: (a, s, ev) => {
    const xs = list(ev(a[0], s));
    const i = num(ev(a[1], s));
    return xs[i < 0 ? xs.length + i : i] ?? null;
  },
  /** [list, start, end?] */
  slice: (a, s, ev) => list(ev(a[0], s)).slice(num(ev(a[1], s)), a.length > 2 ? num(ev(a[2], s)) : undefined),
  append: (a, s, ev) => [...list(ev(a[0], s)), ...a.slice(1).map((x) => ev(x, s))],
  prepend: (a, s, ev) => [...a.slice(1).map((x) => ev(x, s)), ...list(ev(a[0], s))],
  concat: (a, s, ev) => a.flatMap((x) => list(ev(x, s))),
  /** [list, value]: every element equal to value removed */
  remove: (a, s, ev) => {
    const v = ev(a[1], s);
    return list(ev(a[0], s)).filter((x) => !deepEqual(x, v));
  },
  /** [list, value]: value added at the end when absent, removed when present: a selection */
  toggle: (a, s, ev) => {
    const xs = list(ev(a[0], s));
    const v = ev(a[1], s);
    return xs.some((x) => deepEqual(x, v)) ? xs.filter((x) => !deepEqual(x, v)) : [...xs, v];
  },
  uniq: (a, s, ev) => {
    const out: unknown[] = [];
    for (const x of list(ev(a[0], s))) if (!out.some((y) => deepEqual(x, y))) out.push(x);
    return out;
  },
  reverse: (a, s, ev) => list(ev(a[0], s)).slice().reverse(),
  map: lambda((xs, body, s, ev) => xs.map((it, i) => ev(body, withItem(s, it, i)))),
  filter: lambda((xs, body, s, ev) => xs.filter((it, i) => truthy(ev(body, withItem(s, it, i))))),
  find: lambda((xs, body, s, ev) => xs.find((it, i) => truthy(ev(body, withItem(s, it, i)))) ?? null),
  findIndex: lambda((xs, body, s, ev) => xs.findIndex((it, i) => truthy(ev(body, withItem(s, it, i))))),
  some: lambda((xs, body, s, ev) => xs.some((it, i) => truthy(ev(body, withItem(s, it, i))))),
  every: lambda((xs, body, s, ev) => xs.every((it, i) => truthy(ev(body, withItem(s, it, i))))),
  /** [list, body?]: the sum of body over the items, or of the items */
  sum: lambda((xs, body, s, ev) =>
    xs.reduce<number>((t, it, i) => t + num(body === undefined ? it : ev(body, withItem(s, it, i))), 0),
  ),
  /** [list, body?]: how many items body holds for, or how many items */
  count: lambda((xs, body, s, ev) =>
    body === undefined ? xs.length : xs.filter((it, i) => truthy(ev(body, withItem(s, it, i)))).length,
  ),
  /** [list, body, initial]: body sees `acc` */
  reduce: lambda((xs, body, s, ev, rest) =>
    xs.reduce<unknown>((acc, it, i) => ev(body, withItem(s, it, i, { acc })), rest.length ? ev(rest[0], s) : null),
  ),
  /** [list, key body?, "asc"|"desc"?] */
  sort: lambda((xs, body, s, ev, rest) => {
    const dir = rest.length && ev(rest[0], s) === "desc" ? -1 : 1;
    const keyed = xs.map((it, i) => ({ it, k: body === undefined ? it : ev(body, withItem(s, it, i)) }));
    return keyed.sort((x, y) => dir * compare(x.k, y.k)).map((x) => x.it);
  }),
  /** [list, where body, new item body]: each item body holds for replaced by the new one (it is the old) */
  updateWhere: lambda((xs, body, s, ev, rest) =>
    xs.map((it, i) => {
      const scope = withItem(s, it, i);
      return truthy(ev(body, scope)) ? ev(rest[0], scope) : it;
    }),
  ),
  removeWhere: lambda((xs, body, s, ev) => xs.filter((it, i) => !truthy(ev(body, withItem(s, it, i))))),
  /** [list, key body]: an object of the items by their key */
  keyBy: lambda((xs, body, s, ev) => {
    const out: Record<string, unknown> = {};
    xs.forEach((it, i) => {
      const k = str(ev(body, withItem(s, it, i)));
      if (!FORBIDDEN.has(k)) out[k] = it;
    });
    return out;
  }),
  /** [n] or [from, to]: whole numbers, at most 1000 */
  range: (a, s, ev) => {
    const [from, to] = a.length > 1 ? [num(ev(a[0], s)), num(ev(a[1], s))] : [0, num(ev(a[0], s))];
    const n = Math.max(0, Math.min(1000, Math.floor(to - from)));
    return Array.from({ length: n }, (_, i) => from + i);
  },

  // --- objects ------------------------------------------------------------
  /** [object, path] */
  get: (a, s, ev) => readPath(ev(a[0], s), str(ev(a[1], s))) ?? null,
  /** [object, path, value] */
  set: (a, s, ev) => writePath(ev(a[0], s), str(ev(a[1], s)), ev(a[2], s)),
  merge: (a, s, ev) => Object.assign({}, ...a.map((x) => ev(x, s)).filter(isObj)),
  /** [object, key...] */
  omit: (a, s, ev) => {
    const o = ev(a[0], s);
    if (!isObj(o)) return {};
    const drop = new Set(a.slice(1).map((x) => str(ev(x, s))));
    return Object.fromEntries(Object.entries(o).filter(([k]) => !drop.has(k)));
  },
  keys: (a, s, ev) => {
    const o = ev(a[0], s);
    return isObj(o) ? Object.keys(o) : [];
  },
  values: (a, s, ev) => {
    const o = ev(a[0], s);
    return isObj(o) ? Object.values(o) : [];
  },
};

/** Every op the language has: what the validator and the agent's schema list. */
export const EXPR_OPS = Object.keys(OPS).sort();

/** Ops whose second argument is evaluated once per item, with `it` and `index` in scope. */
export const LAMBDA_OPS = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "sum",
  "count",
  "reduce",
  "sort",
  "updateWhere",
  "removeWhere",
  "keyBy",
]);

const opOf = (expr: Record<string, unknown>): string | undefined => {
  const keys = Object.keys(expr);
  return keys.length === 1 ? keys[0] : undefined;
};

const argsOf = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : [raw]);

/** Evaluate an expression in a scope. Throws `ExprError` on an unknown op or a spent budget. */
export function evaluate(expr: Expr, scope: Scope = {}): Json {
  let steps = 0;
  const ev: Evaluator = (e, s) => {
    if (++steps > STEP_BUDGET) throw new ExprError("expression took too many steps");
    if (e === null || typeof e !== "object") return e;
    if (Array.isArray(e)) return e.map((x) => ev(x, s));
    const op = opOf(e as Record<string, unknown>);
    const fn = op === undefined ? undefined : OPS[op];
    if (!fn || op === undefined) throw new ExprError(`not an expression: ${JSON.stringify(e).slice(0, 80)}`);
    // `lit` and `obj` take their argument as written, even a list
    const raw = (e as Record<string, unknown>)[op];
    return fn(op === "lit" || op === "obj" ? [raw] : argsOf(raw), s, ev);
  };
  return toJson(ev(expr, scope));
}

/** Undefined becomes null; nothing else changes. What leaves an expression is JSON. */
function toJson(v: unknown): Json {
  if (v === undefined) return null;
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  if (Array.isArray(v)) return v.map(toJson);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v as Json;
}

export interface ExprIssue {
  /** Where in the expression, as a JSON path. */
  at: string;
  message: string;
}

/**
 * What is wrong with an expression without running it: an unknown op, an object that is not one,
 * a `var` that reads a root the scope will not have.
 */
export function exprIssues(expr: Expr, roots: readonly string[] = [], at = ""): ExprIssue[] {
  const out: ExprIssue[] = [];
  const walk = (e: unknown, where: string, inLambda: boolean) => {
    if (e === null || typeof e !== "object") return;
    if (Array.isArray(e)) {
      e.forEach((x, i) => walk(x, `${where}[${i}]`, inLambda));
      return;
    }
    const op = opOf(e as Record<string, unknown>);
    if (op === undefined || !(op in OPS)) {
      out.push({ at: where, message: `not an expression: an object must be one op (${JSON.stringify(e).slice(0, 60)}); build objects with obj, quote JSON with lit` });
      return;
    }
    const raw = (e as Record<string, unknown>)[op];
    if (op === "lit") return;
    if (op === "obj") {
      if (!isObj(raw)) out.push({ at: where, message: "obj takes an object of expressions" });
      else for (const [k, v] of Object.entries(raw)) walk(v, `${where}.obj.${k}`, inLambda);
      return;
    }
    const args = argsOf(raw);
    if (op === "var" && roots.length > 0 && typeof args[0] === "string") {
      const root = args[0].split(".")[0] ?? "";
      const lambdaRoot = root === "it" || root === "index" || root === "acc";
      if (!(roots.includes(root) || (inLambda && lambdaRoot))) {
        out.push({ at: where, message: `reads "${root}", which is not in scope here (${[...roots, ...(inLambda ? ["it", "index", "acc"] : [])].join(", ")})` });
      }
    }
    args.forEach((x, i) => walk(x, `${where}.${op}[${i}]`, inLambda || (LAMBDA_OPS.has(op) && i >= 1)));
  };
  walk(expr, at, false);
  return out;
}

/** The paths an expression reads with `var` (literal paths only), outside lambda roots. */
export function exprReads(expr: Expr): string[] {
  const out = new Set<string>();
  const walk = (e: unknown) => {
    if (e === null || typeof e !== "object") return;
    if (Array.isArray(e)) return e.forEach(walk);
    const op = opOf(e as Record<string, unknown>);
    if (op === undefined || op === "lit") return;
    const raw = (e as Record<string, unknown>)[op];
    if (op === "obj") {
      if (isObj(raw)) Object.values(raw).forEach(walk);
      return;
    }
    const args = argsOf(raw);
    if (op === "var" && typeof args[0] === "string") {
      const root = args[0].split(".")[0];
      if (root !== "it" && root !== "index" && root !== "acc") out.add(args[0]);
    }
    args.forEach(walk);
  };
  walk(expr);
  return [...out];
}

export const isTruthy = truthy;
