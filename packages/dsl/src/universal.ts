/**
 * Part 3 — Universal props.
 *
 * Carried by every node type. `id` and `src` live on the wire envelope rather
 * than in `props`, because the flat format needs them to resolve parentage
 * before it has looked at a single prop.
 *
 * Logical `start`/`end` throughout, never `left`/`right`. ICC will need RTL and
 * retrofitting direction into a shipped vocabulary is miserable.
 */

import { f, opt, req, type Fields } from "./field.js";

/**
 * Padding. One namespace with shorthand (`p`, `px`, `py`) and longhand, which
 * is the vocabulary designers already use.
 */
export const spaceFields: Fields = {
  p: opt(f.val(), { resp: true, doc: "all sides" }),
  px: opt(f.val(), { resp: true, doc: "inline (start + end)" }),
  py: opt(f.val(), { resp: true, doc: "block (top + bottom)" }),
  pt: opt(f.val(), { resp: true }),
  pr: opt(f.val(), { resp: true }),
  pb: opt(f.val(), { resp: true }),
  pl: opt(f.val(), { resp: true }),
};

export const sizeFields: Fields = {
  w: opt(f.size(), { resp: true }),
  h: opt(f.size(), { resp: true }),
  minW: opt(f.size(), { resp: true }),
  maxW: opt(f.size(), { resp: true }),
  minH: opt(f.size(), { resp: true }),
  maxH: opt(f.size(), { resp: true }),
  ratio: opt(f.ratio(), { doc: "e.g. `37/50`" }),
};

/**
 * Positioning lives on the CHILD, not the parent.
 *
 * Overlay anchoring and Grid spanning are both child-positional, so they share
 * one namespace — one thing for the agent to learn instead of two, and the
 * validator can check each against the parent's type (S6, S7).
 */
export const placeFields: Fields = {
  anchor: opt(f.anchor(), { doc: "Overlay children only" }),
  offset: opt(
    f.obj({
      block: opt(f.offset()),
      inline: opt(f.offset()),
    }),
  ),
  span: opt(f.num(true), { resp: true, doc: "Grid children only" }),
  z: opt(f.num(true), { doc: "explicit override; never a layout mechanism" }),
};

export const semanticsFields: Fields = {
  as: opt(f.str()),
  label: opt(f.str()),
  role: opt(f.str()),
};

export const metaFields: Fields = {
  derivedFrom: opt(f.str()),
  fidelity: opt(f.num()),
  note: opt(f.str()),
  /**
   * Figma ids whose DSL nodes were folded away into a Repeater's template.
   *
   * Written by `applyCollapse` and read by drift detection and @fanos/conform:
   * `src` is the anchor that maps a Figma node to the thing that draws it, and
   * collapsing five cards into one deletes four fifths of those anchors. Without
   * this list the next export of the same frame looks like someone deleted four
   * cards. It holds every id under the removed members, not just their roots,
   * because coverage is counted per painting node.
   */
  collapsedFrom: opt(f.arr(f.str()), { doc: "src ids a Repeater stands in for" }),
  /**
   * Deliberate departures from the Figma IR, each naming the conformance check
   * it answers and why. @fanos/conform downgrades a matching failure to an info
   * line instead of failing the build.
   *
   * This lives on the node rather than in a sidecar so the justification travels
   * with the thing it justifies. Real cases exist — the player cutout is
   * `contain` against the IR's CROP because our stand-in asset is a different
   * shape from the one the designer cropped — and a gate with no way to record
   * that gets switched off the first time it is inconveniently right.
   */
  deviations: opt(
    f.arr(
      f.obj({
        check: req(f.str()),
        reason: req(f.str()),
        /**
         * How many findings this waiver covers; beyond it they are errors
         * again. Without a bound, a waiver on a container is a blanket amnesty
         * for everything beneath it — the one that excuses the player card's 46
         * background vectors would also excuse the player's name going missing.
         */
        max: opt(f.num(true)),
      }),
    ),
    { doc: "each entry waives one conformance check on this node" },
  ),
};

export const REVEALS = ["none", "fade", "fade-up", "scale"] as const;
export const PLATFORMS = ["web", "native"] as const;
export const BLENDS = [
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-lighter",
] as const;

/**
 * A move, a scale or a turn of the node's own box, after layout: siblings do not move. Shifts are
 * space tokens (or Raw px); scale is a factor; rotate is degrees.
 */
const transformFields: Fields = {
  scale: opt(f.num(), { doc: "1 is as laid out" }),
  x: opt(f.val(), { doc: "inline shift; a negative token (`-space.4`) moves it back" }),
  y: opt(f.val(), { doc: "block shift" }),
  rotate: opt(f.num(), { doc: "degrees, clockwise" }),
};

/** What a state may change: the look, never the layout. */
const stateFields: Fields = {
  surface: opt(f.token("surface")),
  fill: opt(f.token("color"), { doc: "a plain background colour, in place of the surface" }),
  tone: opt(f.token("color"), { doc: "text and glyph colour, on a Text, Icon or Button" }),
  opacity: opt(f.token("opacity")),
  transform: opt(f.obj(transformFields)),
};

/**
 * The states a node can be in, and how it looks in each. `hover`, `pressed` and `focus` come from
 * the pointer and keyboard. `active`, `inactive` and `disabled` are set by what the node belongs
 * to: a carousel's slide on show and the others, its current page's dot, an arrow with nowhere
 * to go. A state the node is not in changes nothing.
 */
const statesFields: Fields = {
  hover: opt(f.obj(stateFields)),
  pressed: opt(f.obj(stateFields)),
  focus: opt(f.obj(stateFields), { doc: "keyboard focus" }),
  active: opt(f.obj(stateFields)),
  inactive: opt(f.obj(stateFields)),
  disabled: opt(f.obj(stateFields)),
};

export const universalFields: Fields = {
  surface: opt(f.token("surface"), { resp: true }),
  space: opt(f.obj(spaceFields)),
  size: opt(f.obj(sizeFields)),
  place: opt(f.obj(placeFields)),
  /** How the node mixes with what is under it. Default: it paints over it. */
  blend: opt(f.enum(...BLENDS)),
  /**
   * The design width, on a node that keeps its content in a centred column of it
   * while its own box may be wider: a full-width bar, or something placed in one.
   * Exactly at that width it changes nothing.
   */
  column: opt(f.num()),
  reveal: opt(f.enum(...REVEALS)),
  /** Duration token (or Raw ms). Never a space token — see T5. */
  revealDelay: opt(f.val("duration"), { resp: true }),
  platform: opt(f.arr(f.enum(...PLATFORMS))),
  semantics: opt(f.obj(semanticsFields)),
  testId: opt(f.str()),
  /**
   * Draw this node only when the data says so — the video badge on a video,
   * the duration chip when there is a duration. Evaluated in the node's own
   * scope, so inside a Repeater it can test the item. See `binding.ts`.
   */
  when: opt(f.predicate(), { doc: '{ path, eq|ne|in|exists|gt|gte|lt|lte } or a list (all must hold)' }),
  /**
   * This node is a designed control of a Carousel elsewhere in the tree: its previous or next
   * arrow, or its row of pagination dots.
   *
   * A design draws its own arrows and dots, and they have to look exactly as drawn, so they stay
   * nodes, OUTSIDE the Carousel (S10 is about chrome among its slides). The renderer wires them:
   * prev and next move the carousel; in `pagination` each child is one page's dot, and the one
   * drawn active moves its look to the page on show. `target` is the Carousel's node id (S16).
   */
  controlFor: opt(
    f.obj({
      target: req(f.str()),
      part: req(f.enum("prev", "next", "pagination", "counter", "progress")),
      format: opt(f.str(), { doc: 'counter only: the text, with {index} and {count} (default "{index} / {count}")' }),
      of: opt(f.enum("autoplay", "slides"), {
        doc: "progress only: the time left on this slide (default), or how far through the slides",
      }),
    }),
    {
      doc: "a control of the Carousel `target`, as a node with its own look: prev, next, pagination (its children are the dots; one child is repeated per page), counter (a Text), progress (filled by scale) (S16)",
    },
  ),
  /**
   * A plain background colour from the theme, for a node with no surface: a dot, a bar, an arrow's
   * disc. A surface is a bundle (layers, border, radius); this is one colour.
   */
  fill: opt(f.token("color")),
  /** See-through, as a theme opacity token. */
  opacity: opt(f.token("opacity")),
  transform: opt(f.obj(transformFields)),
  states: opt(f.obj(statesFields), { doc: "how it looks when hovered, pressed, focused, active, inactive or disabled" }),
  /** How a change of state or of a carousel's slide eases in, rather than snapping. */
  transition: opt(
    f.obj({
      duration: req(f.val("duration")),
      easing: opt(f.token("easing")),
      delay: opt(f.val("duration")),
    }),
  ),
  _meta: opt(f.obj(metaFields)),
};

/** The universal prop names, for S5's "Repeater carries no layout props" check. */
export const UNIVERSAL_PROP_NAMES = Object.keys(universalFields);

/**
 * What a Repeater may NOT carry. It is a fragment, not a container: it emits n
 * children into its parent's layout. Everything here would give it a box of its
 * own and quietly break `Stack > Repeater`.
 */
export const REPEATER_FORBIDDEN_PROPS = [
  "surface",
  "space",
  "size",
  "place",
  // a look needs a box to paint, and a fragment has none
  "fill",
  "opacity",
  "transform",
  "states",
  "transition",
] as const;

/**
 * Layout props belonging to the container types.
 *
 * A fragment carrying one of these is the same mistake as carrying `space` — it
 * is reaching for a box it does not have — so S5 names it explicitly rather than
 * letting it fall through as a generic "unrecognized key", which reads like a
 * typo instead of a modelling error.
 */
export const LAYOUT_PROP_NAMES = [
  "gap",
  "direction",
  "align",
  "justify",
  "wrap",
  "columns",
  "rows",
  "columnGap",
  "rowGap",
  "minItemWidth",
] as const;
