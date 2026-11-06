/**
 * Reading and writing a prop the way the property panel shows it.
 *
 * Kept apart from `panel.ts` because a browser draws the panel: this file imports nothing, so it
 * is in `@fanos/dsl/runtime` too, where `panel.ts` (which walks the node registry) is not.
 */

/** How one prop is edited. Anything the panel cannot draw a control for is `json`. */
export type PanelControl =
  | { k: "text" }
  | { k: "number"; int: boolean }
  | { k: "toggle" }
  | { k: "select"; options: string[] }
  | { k: "token"; category: string }
  /** A token, or a plain px number (`Raw`). `keywords` are the words it also takes. */
  | { k: "measure"; category: string; keywords: string[]; percent: boolean; signed: boolean }
  | { k: "json" };


const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRaw = (v: unknown): boolean => isObject(v) && v._unbound === true && "raw" in v;
const isResp = (v: unknown): boolean => isObject(v) && "base" in v && !isRaw(v);


/** Reads a dotted path out of a node's props. */
export function readProp(props: Record<string, unknown>, path: string): unknown {
  let at: unknown = props;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** What the panel shows for a prop: a responsive value shows its base. */
export function shownValue(value: unknown, resp: boolean): unknown {
  return resp && isResp(value) ? (value as { base: unknown }).base : value;
}

/**
 * The value to store when the panel sets a prop. A responsive prop that already has breakpoint
 * overrides keeps them and changes only its base; `undefined` clears the base (or the prop).
 */
export function storedValue(current: unknown, next: unknown, resp: boolean): unknown {
  if (resp && isResp(current)) {
    const { base: _base, ...overrides } = current as { base: unknown } & Record<string, unknown>;
    if (next === undefined) return Object.keys(overrides).length > 0 ? overrides : undefined;
    return { ...overrides, base: next };
  }
  return next;
}

/** A plain number the panel typed into a measure, as the vocabulary writes it. */
export function measureOf(text: string, control: Extract<PanelControl, { k: "measure" }>): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (control.keywords.includes(t)) return t;
  if (control.category === "count") return Number.isFinite(Number(t)) ? Number(t) : undefined;
  if (control.percent && /^-?\d+(?:\.\d+)?%$/.test(t)) return t;
  if (/^-?(?:space|duration)\.[A-Za-z0-9_.]+$/.test(t)) return t;
  const n = Number(t);
  return Number.isFinite(n) ? { raw: n, _unbound: true } : undefined;
}

/** A measure's value, as the text the panel shows in its box. */
export function measureText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isRaw(value)) return String((value as { raw: unknown }).raw);
  return typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
}
