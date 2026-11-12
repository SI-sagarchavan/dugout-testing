/**
 * A node's behaviour, on the server: what it sends its section's machine (`on`), which of its looks
 * follow state (`statesWhen`), and the characters of a Text that reads state. The server resolves
 * everything it can from the data (a row's `{player.id}`, `$user.name`) and draws each look and
 * each text as the state reads at the first moment; what changes in the browser is handed over as
 * attributes (`state/dom.ts` reads them) and as the client's `StateText`.
 */

import {
  type Condition,
  evaluateCondition,
  isLivePath,
  type Json,
  lookup,
  parseRefs,
  predicateSchema,
  conditionsOf,
  refRegex,
  resolveTemplate,
  splitLiveWhen,
  type Node,
} from "@fanos/dsl";
import { localeOf, type NodeRenderContext } from "../context.js";

/** Set by the renderer on a node: its events, resolved. Not props of the tree. */
export const STATE_ON = "__fosOn";
/** Set by the renderer on a node: its looks that follow state, and the ones it is drawn in. */
export const STATE_LOOKS = "__fosLooks";

export interface DrawnLooks {
  /** The conditions of each look, made to read only state. */
  looks: Partial<Record<"active" | "inactive" | "disabled" | "expanded", Condition[]>>;
  /** The looks it is drawn in now. */
  states: string[];
  expanded?: boolean;
  disabled?: boolean;
}

/** A condition of `_page`, which keeps ADR 0032's gate. */
export const isLegacyPage = (c: Condition): boolean =>
  [c.path, c.eqPath, c.hasPath, c.lacksPath, c.containsPath].some((p) => p !== undefined && (p === "_page" || p.startsWith("_page.")));

const WHOLE_REF = /^\{\s*([$A-Za-z_][A-Za-z0-9_.]*)\s*\}$/;

/** A payload value: a literal, or a template read where the node is drawn (one ref keeps its type). */
function payloadValue(value: unknown, ctx: NodeRenderContext): Json {
  if (typeof value !== "string") return (value ?? null) as Json;
  const whole = WHOLE_REF.exec(value);
  if (whole) return (lookup(ctx.data, whole[1]!) ?? null) as Json;
  return value.includes("{") ? resolveTemplate(value, ctx.data, localeOf(ctx)).value : value;
}

/** The node with its events and state-driven looks resolved into props the components draw. */
export function behaviourOf(node: Node, ctx: NodeRenderContext): Node {
  const props = node.props as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  const on = props.on as Record<string, { send?: unknown; payload?: unknown; to?: unknown }> | undefined;
  if (on && typeof on === "object") {
    const handlers: Record<string, unknown> = {};
    for (const [kind, h] of Object.entries(on)) {
      if (!h || typeof h.send !== "string") continue;
      const payload: Record<string, Json> = {};
      if (h.payload && typeof h.payload === "object") {
        for (const [k, v] of Object.entries(h.payload as Record<string, unknown>)) payload[k] = payloadValue(v, ctx);
      }
      handlers[kind] = { send: h.send, ...(Object.keys(payload).length ? { payload } : {}), ...(h.to === "page" ? { to: "page" } : {}) };
    }
    if (Object.keys(handlers).length) extra[STATE_ON] = handlers;
  }
  const statesWhen = props.statesWhen as Record<string, unknown> | undefined;
  if (statesWhen && typeof statesWhen === "object") {
    const drawn: DrawnLooks = { looks: {}, states: [] };
    for (const key of ["active", "inactive", "disabled", "expanded"] as const) {
      const p = statesWhen[key];
      if (p === undefined) continue;
      const split = splitLiveWhen(p, ctx.data);
      const parsed = predicateSchema.safeParse(split.now);
      const fixed = split.now === undefined ? true : parsed.success && conditionsOf(parsed.data).every((c) => evaluateCondition(c, ctx.data));
      const holds = fixed && split.live.every((c) => evaluateCondition(c, ctx.data));
      // what the data alone decides is decided; only the rest is the browser's
      if (fixed && split.live.length) drawn.looks[key] = split.live;
      if (key === "active") drawn.states.push(holds ? "active" : "inactive");
      else if (key === "expanded") drawn.expanded = holds;
      else if (holds) drawn.states.push(key);
      if (key === "disabled") drawn.disabled = holds;
    }
    extra[STATE_LOOKS] = drawn;
  }
  return Object.keys(extra).length ? ({ ...node, props: { ...props, ...extra } } as Node) : node;
}

/** The entry of a list in state that is this item's: the key itself, or the object whose `by` holds it. */
export function entryIn(list: unknown, key: Json, by: string | undefined): Json | undefined {
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((e) => (by ? e !== null && typeof e === "object" && (e as Record<string, unknown>)[by] === key : e === key));
  return hit as Json | undefined;
}

/**
 * A template that reads state, in pieces: literal text and the refs to anything else resolved now,
 * the refs to state kept as written for the browser. Undefined when it reads no live state.
 */
export function stateParts(template: string, ctx: NodeRenderContext): { parts: Array<string | { ref: string }>; initial: string } | undefined {
  if (!template.includes("{") || !parseRefs(template).some((r) => isLivePath(r.path))) return undefined;
  const parts: Array<string | { ref: string }> = [];
  let last = 0;
  for (const match of template.matchAll(refRegex())) {
    const at = match.index ?? 0;
    if (at > last) parts.push(template.slice(last, at));
    const path = match[1] ?? "";
    parts.push(isLivePath(path) ? { ref: match[0] } : resolveTemplate(match[0], ctx.data, localeOf(ctx)).value);
    last = at + match[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return { parts, initial: resolveTemplate(template, ctx.data, localeOf(ctx)).value };
}
