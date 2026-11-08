/**
 * How a node looks beyond its surface, and how it looks in each state: all from its props.
 *
 * - `fill`, `opacity`, `transform` and `transition` are inline style, each a token's CSS var.
 * - A state's `surface` is a class: the token compiler gives every surface rule the selectors for
 *   `.fos-s-<state>-<surface>` in that state, so the whole surface (layers, border, radius,
 *   shadow) swaps with no CSS here.
 * - A state's `fill`, `tone`, `opacity` and `transform` are rules this module writes for the
 *   tree, one per node and state, from the same tokens. Inline style is the node's base look, so
 *   a state's rule must outweigh it (`!important`). `tone` also colours the node's own text and
 *   glyphs, so an arrow's disabled colour reaches the icon drawn inside it.
 *
 * Nothing here is a look of its own: every value is a token the tree names.
 */

import type { FlatTree } from "@fanos/dsl";
import { cssStateClassName, cssVar, NODE_STATES, type NodeState, stateCondition } from "@fanos/tokens";
import type { CssProperties } from "./anchor.js";
import { resolveDuration, resolveValue } from "./value.js";

interface Transform {
  scale?: number;
  x?: unknown;
  y?: unknown;
  rotate?: number;
}

interface StateLook {
  surface?: string;
  fill?: string;
  tone?: string;
  opacity?: string;
  transform?: Transform;
}

const token = (ref: unknown, prefix: string): string | undefined =>
  typeof ref === "string" && ref.startsWith(prefix) ? cssVar(ref) : undefined;

/** A transform as CSS, or undefined when it does nothing. */
export function transformCss(t: Transform | undefined): string | undefined {
  if (!t) return undefined;
  const parts: string[] = [];
  const x = t.x === undefined ? undefined : resolveValue(t.x).css;
  const y = t.y === undefined ? undefined : resolveValue(t.y).css;
  if (x || y) parts.push(`translate(${x || "0px"}, ${y || "0px"})`);
  if (typeof t.rotate === "number" && t.rotate !== 0) parts.push(`rotate(${t.rotate}deg)`);
  if (typeof t.scale === "number" && t.scale !== 1) parts.push(`scale(${t.scale})`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The properties a state or a transition can change. Layout never changes with a state. */
const LOOK_PROPERTIES = ["background-color", "background-image", "color", "opacity", "transform", "border-color", "box-shadow"];

/** The node's base look beyond its surface, as inline style. */
export function lookStyle(props: Record<string, unknown>): CssProperties {
  const style: CssProperties = {};
  const fill = token(props.fill, "color.");
  if (fill) style.backgroundColor = fill;
  const opacity = token(props.opacity, "opacity.");
  if (opacity) style.opacity = opacity;
  const transform = transformCss(props.transform as Transform | undefined);
  if (transform) style.transform = transform;
  const t = props.transition as { duration?: unknown; easing?: unknown; delay?: unknown } | undefined;
  if (t?.duration !== undefined) {
    const duration = resolveDuration(t.duration).css;
    const easing = token(t.easing, "easing.") ?? "ease";
    const delay = t.delay === undefined ? "" : ` ${resolveDuration(t.delay).css}`;
    style.transition = LOOK_PROPERTIES.map((p) => `${p} ${duration} ${easing}${delay}`).join(", ");
  }
  return style;
}

const statesOf = (props: Record<string, unknown>) =>
  (props.states ?? {}) as Partial<Record<NodeState, StateLook>>;

/** The classes that give the node a surface in a state. */
export function stateClasses(props: Record<string, unknown>): string[] {
  const states = statesOf(props);
  return NODE_STATES.flatMap((state) => {
    const surface = states[state]?.surface;
    return typeof surface === "string" && surface.startsWith("surface.")
      ? [cssStateClassName(state, surface.slice("surface.".length))]
      : [];
  });
}

/** The states a node has a look for, for what sets them (a carousel) to know. */
export function stateNames(props: Record<string, unknown>): string[] {
  const states = statesOf(props);
  return NODE_STATES.filter((s) => states[s] !== undefined);
}

/**
 * The rules for every node of the tree that has a look in some state. `scope` keeps one tree's
 * rules off another tree on the same page that reuses its node ids.
 */
export function stateRules(tree: FlatTree, scope: string): string {
  const rules: string[] = [];
  const root = `[data-fos-tree="${scope}"]`;
  for (const node of tree.nodes) {
    const props = node.props as Record<string, unknown>;
    if (!props.states) continue;
    const states = statesOf(props);
    for (const state of NODE_STATES) {
      const look = states[state];
      if (!look) continue;
      const decls: string[] = [];
      const fill = token(look.fill, "color.");
      if (fill) decls.push(`background: ${fill}`);
      const opacity = token(look.opacity, "opacity.");
      if (opacity) decls.push(`opacity: ${opacity}`);
      if (look.transform) {
        // A state's transform adds to the node's own: a hover that scales keeps the node's shift.
        const merged = transformCss({ ...((props.transform as Transform | undefined) ?? {}), ...look.transform });
        decls.push(`transform: ${merged ?? "none"}`);
      }
      // A Checkbox's focus is on the real input inside it, so its box's focus look reads it from there.
      const condition =
        state === "focus" && node.type === "Checkbox" ? ":has(> input:focus-visible)" : stateCondition(state);
      const self = `${root} [data-fos-id="${CSS_ESCAPE(node.id)}"]${condition}`;
      if (decls.length > 0) rules.push(`${self} { ${decls.map((d) => `${d} !important`).join("; ")}; }`);
      const tone = token(look.tone, "color.");
      if (tone) {
        // The node's own colour, and its text and glyphs, which carry a colour of their own.
        const targets = [self, `${self} [data-fos-type="Text"]`, `${self} [data-fos-type="Icon"]`];
        rules.push(`${targets.join(", ")} { color: ${tone} !important; }`);
      }
    }
  }
  return rules.join("\n");
}

/** A node id inside a double-quoted attribute selector. */
function CSS_ESCAPE(id: string): string {
  return id.replace(/["\\]/g, "\\$&");
}
