/**
 * Part 4 — Structural nodes (8).
 */

import { f, opt, req, type Fields } from "../field.js";

export interface NodeSpec {
  type: string;
  kind: "structural" | "leaf";
  doc: string;
  /** Node-specific props. Universal props are merged in by the registry. */
  fields: Fields;
  /**
   * A fragment emits its children into the PARENT's layout and has no box of
   * its own, so it carries no universal layout props (S5).
   */
  fragment?: boolean;
}

const ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;
const JUSTIFY = ["start", "center", "end", "between", "around", "evenly"] as const;

export const STRUCTURAL_NODES: NodeSpec[] = [
  {
    type: "Box",
    kind: "structural",
    doc: "No layout algorithm. Universal props only. The div.",
    fields: {
      clip: opt(f.bool(), { doc: "default false" }),
    },
  },

  {
    type: "Stack",
    kind: "structural",
    doc: "One-dimensional flow. The workhorse container.",
    fields: {
      /**
       * Not an Overlay-only concern. Figma reports `clipsContent` on ANY frame,
       * and a design leans on it: the fixture row is 235px tall inside a 227px
       * shell precisely so the cards bleed and get cut, leaving no gap for the
       * shell colour to show through. Without this the vocabulary cannot say
       * that, and the overflow paints over whatever follows.
       */
      clip: opt(f.bool(), { doc: "default false" }),
      direction: opt(f.enum("row", "column"), { resp: true, doc: 'default "column"' }),
      gap: opt(f.val(), { resp: true }),
      align: opt(f.enum(...ALIGN), { resp: true, doc: "cross axis" }),
      justify: opt(f.enum(...JUSTIFY), { resp: true, doc: "main axis" }),
      wrap: opt(f.bool(), { resp: true }),
    },
  },

  {
    type: "Grid",
    kind: "structural",
    doc: "Two-dimensional layout. No template strings — those are raw values in disguise.",
    fields: {
      columns: req(f.union(f.num(true), f.enum("auto")), { resp: true }),
      minItemWidth: opt(f.val(), { resp: true, doc: 'required iff columns === "auto" (S9)' }),
      rows: opt(f.num(true), { resp: true }),
      gap: opt(f.val(), { resp: true }),
      columnGap: opt(f.val(), { resp: true }),
      rowGap: opt(f.val(), { resp: true }),
      align: opt(f.enum(...ALIGN), { resp: true }),
      justify: opt(f.enum(...JUSTIFY), { resp: true }),
    },
  },

  {
    type: "Section",
    kind: "structural",
    doc: "A top-level page band. The only node an editor reorders in Admin, so its id must derive from its Figma node id and survive regeneration.",
    fields: {
      width: req(f.enum("full", "wide", "content", "narrow")),
      gap: opt(f.val(), { resp: true }),
      backdrop: opt(f.token("surface"), { resp: true, doc: "full-bleed, behind content" }),
      anchor: opt(f.str(), { doc: "in-page nav target" }),
    },
  },

  {
    type: "Overlay",
    kind: "structural",
    doc: "Children stack in child order, each positioned by its own place.anchor. z-index is never exposed as a layout mechanism.",
    fields: {
      clip: opt(f.bool(), { doc: "default false" }),
    },
  },

  {
    type: "Carousel",
    kind: "structural",
    doc: "A Swiper slider: behaviour and motion only, it draws nothing of its own. Every child is one slide, and every repetition of a Repeater child is one slide; a slide's look on show and off it is its `states.active` / `states.inactive`. Arrows, dots, a counter and a progress bar are ordinary nodes anywhere in the tree (beside it in an Overlay, or inside a slide) with `controlFor` naming this carousel. Each field maps to one Swiper option, named in its doc.",
    fields: {
      // --- Layout ---------------------------------------------------------
      slidesPerView: req(f.union(f.num(), f.enum("auto")), {
        resp: true,
        doc: 'slidesPerView. A fraction shows part of the next slide (1.2 = one slide and a peek); "auto" takes each slide\'s own width',
      }),
      slidesPerGroup: opt(f.num(true), { resp: true, doc: "slidesPerGroup: slides moved per step (default 1)" }),
      gap: opt(f.val(), { resp: true, doc: "spaceBetween, as a space token" }),
      offsetBefore: opt(f.val(), { resp: true, doc: "slidesOffsetBefore: space before the first slide" }),
      offsetAfter: opt(f.val(), { resp: true, doc: "slidesOffsetAfter: space after the last slide" }),
      centered: opt(f.bool(), { doc: "centeredSlides: the active slide sits in the middle" }),
      centeredBounds: opt(f.bool(), { doc: "centeredSlidesBounds: centred, without gaps at the ends" }),
      /**
       * Where the active slide's centre lies, from the first slide's start, as designed.
       *
       * Not a Swiper option: Swiper centres once it runs and measures. Until then the server's
       * markup is all there is (and all a screenshot sees), so the first paint centres the
       * active slide with this. As a distance from the slides' own start it stays centred at any
       * container width.
       */
      centerAt: opt(f.num(), { doc: "centered only: px from the first slide's start to the active slide's centre, for the first paint" }),
      /**
       * A carousel that bleeds: slides past its box stay on show until something above clips
       * them, as a design runs a row of cards off to the page edge. Swiper still scrolls by the
       * carousel's own width.
       */
      clip: opt(f.bool(), { doc: "default true: slides past the carousel's box are hidden. false: they show until an ancestor clips" }),
      direction: opt(f.enum("horizontal", "vertical"), {
        doc: 'direction (default "horizontal"); vertical needs a fixed size.h (S15)',
      }),
      align: opt(f.enum("start", "center", "end", "stretch"), {
        doc: 'where slides of different heights sit across the row (default "stretch"), as the Stack the design drew',
      }),
      rows: opt(f.num(true), { resp: true, doc: "grid.rows: slides in several rows (not with loop, S15)" }),
      rowFill: opt(f.enum("row", "column"), { doc: 'grid.fill (default "column")' }),
      autoHeight: opt(f.bool(), { doc: "autoHeight: the carousel takes the height of the active slide" }),
      initialSlide: opt(f.num(true), { doc: "initialSlide: index of the slide shown first (default 0)" }),

      // --- Motion -----------------------------------------------------------
      /**
       * How slides move: Swiper's effect and all its options. A string is the effect with its
       * defaults. `creative` places the slides beside the active one anywhere in 3D, which is how
       * a stack of cards, a fan or a peek with dimmed neighbours is said.
       */
      effect: opt(
        f.union(
          f.enum("slide", "fade", "cube", "coverflow", "flip", "cards", "creative"),
          f.obj({ kind: req(f.literals("slide")) }),
          f.obj({ kind: req(f.literals("fade")), crossFade: opt(f.bool(), { doc: "default true" }) }),
          f.obj({
            kind: req(f.literals("coverflow")),
            rotate: opt(f.num(), { doc: "degrees each side slide turns (default 50)" }),
            stretch: opt(f.num(), { doc: "px the slides draw together" }),
            depth: opt(f.num(), { doc: "px the side slides sit back (default 100)" }),
            scale: opt(f.num(), { doc: "side slides' scale (default 1)" }),
            modifier: opt(f.num(), { doc: "multiplies the above (default 1)" }),
            shadows: opt(f.bool()),
          }),
          f.obj({
            kind: req(f.literals("cards")),
            rotate: opt(f.bool(), { doc: "the cards behind tilt (default true)" }),
            perSlideOffset: opt(f.num(), { doc: "px between the cards behind (default 8)" }),
            perSlideRotate: opt(f.num(), { doc: "degrees per card behind (default 2)" }),
            shadows: opt(f.bool()),
          }),
          f.obj({
            kind: req(f.literals("creative")),
            prev: req(f.obj({
              translate: opt(f.arr(f.union(f.num(), f.str())), { doc: "[x, y, z]: px, or a percent of the slide (\"-45%\")" }),
              rotate: opt(f.arr(f.num()), { doc: "[x, y, z] in degrees" }),
              scale: opt(f.num()),
              opacity: opt(f.num(), { doc: "0 to 1" }),
              origin: opt(f.str(), { doc: 'transform-origin, e.g. "center bottom"' }),
              shadow: opt(f.bool()),
            }), { doc: "where the slide before the active one sits" }),
            next: req(f.obj({
              translate: opt(f.arr(f.union(f.num(), f.str())), { doc: "[x, y, z]: px, or a percent of the slide (\"-45%\")" }),
              rotate: opt(f.arr(f.num()), { doc: "[x, y, z] in degrees" }),
              scale: opt(f.num()),
              opacity: opt(f.num(), { doc: "0 to 1" }),
              origin: opt(f.str(), { doc: 'transform-origin, e.g. "center bottom"' }),
              shadow: opt(f.bool()),
            }), { doc: "where the slide after it sits" }),
            limitProgress: opt(f.num(true), { doc: "how many slides each side take the transform, scaled (default 1)" }),
            perspective: opt(f.bool(), { doc: "default true" }),
          }),
          f.obj({ kind: req(f.literals("cube")), shadow: opt(f.bool()), slideShadows: opt(f.bool()) }),
          f.obj({ kind: req(f.literals("flip")), slideShadows: opt(f.bool()) }),
        ),
        { doc: 'effect (default "slide"). Every effect but slide, coverflow and creative shows one slide at a time (S15)' },
      ),
      easing: opt(f.token("easing"), { doc: "how a slide change eases (Swiper's wrapper transition)" }),
      speed: opt(f.val("duration"), { doc: "speed: duration of one transition (default 300ms)" }),
      loop: opt(f.bool(), { doc: "loop: wrap around without an end (default false)" }),
      rewind: opt(f.bool(), { doc: "rewind: next on the last slide goes back to the first; not with loop (S15)" }),
      autoplay: req(
        f.union(
          f.literals(false),
          f.obj({
            delay: req(f.val("duration"), { doc: "autoplay.delay: time on each slide" }),
            pauseOnHover: opt(f.bool(), { doc: "autoplay.pauseOnMouseEnter (default true)" }),
            stopOnInteraction: opt(f.bool(), { doc: "autoplay.disableOnInteraction (default false)" }),
            stopOnLast: opt(f.bool(), { doc: "autoplay.stopOnLastSlide (default false)" }),
            reverse: opt(f.bool(), { doc: "autoplay.reverseDirection (default false)" }),
          }),
        ),
        { doc: "false, or autoplay options" },
      ),
      freeMode: opt(
        f.union(f.bool(), f.obj({ momentum: opt(f.bool()), sticky: opt(f.bool(), { doc: "snap to a slide when it stops" }) })),
        { doc: "freeMode: scroll freely instead of slide by slide" },
      ),

      // --- Input ------------------------------------------------------------
      draggable: opt(f.bool(), { doc: "allowTouchMove: swipe and drag (default true)" }),
      grabCursor: opt(f.bool(), { doc: "grabCursor (default false)" }),
      keyboard: opt(f.bool(), { doc: "keyboard: arrow keys while in view (default true)" }),
      mousewheel: opt(f.bool(), { doc: "mousewheel (default false)" }),
      slideToClicked: opt(f.bool(), { doc: "slideToClickedSlide (default false)" }),
    },
  },

  {
    type: "Repeater",
    kind: "structural",
    fragment: true,
    doc: "A FRAGMENT, not a container: it emits n children into its parent's layout and has no layout, space, size or surface props of its own. That is what lets Stack > Repeater and Carousel > Repeater both work without duplicating layout props.",
    fields: {
      over: req(f.str()),
      as: req(f.str()),
      limit: opt(f.num(true)),
      /**
       * `[start, end)` — a window on `over`, end exclusive.
       *
       * For the index-tiered grid, which is how editorial pages are actually
       * laid out: one source list of six articles drawn as a lead, then two
       * feature cards, then three briefs. Each tier is a different card, and
       * which tier an item lands in is decided by its POSITION in the list.
       *
       * `when` cannot say this. A predicate tests a field on the item, and
       * nothing on article #4 marks it as a brief — it is a brief because it
       * is fourth. Without `slice` the only way to draw the page is three
       * hand-maintained arrays, which puts an editor's ordering decision in
       * three places and guarantees they drift.
       *
       * Mutually exclusive with `limit` (S13): both cap the same list, and a
       * tree that says `slice: [3, 6], limit: 2` has two answers.
       */
      slice: opt(f.arr(f.num(true)), { doc: "[start, end) — end exclusive; not with `limit` (S13)" }),
      /**
       * Its own children drawn once between two items instead of in each, in order: the rule
       * between stats (`stat | stat | stat`), a spacer and a rule, a chevron between crumbs. They
       * draw in the Repeater's scope, not an item's. A Carousel draws none: its `gap` is the space
       * between slides.
       */
      separator: opt(f.arr(f.str()), { doc: "ids of its children drawn between items instead of in each, in order (a rule between stats)" }),
      paginate: opt(
        f.obj({
          mode: req(f.enum("pages", "more", "infinite")),
          pageSize: req(f.num(true)),
          urlKey: opt(f.str()),
        }),
        { doc: "phase 2 — schema only" },
      ),
    },
  },

  {
    type: "Custom",
    kind: "structural",
    doc: "Opaque rendering, but binding refs inside still validate.",
    fields: {
      ref: req(f.semverRef(), { doc: "`name@1.2.3` (S11)" }),
      props: req(f.opaque()),
      fallbackHeight: opt(f.val(), { resp: true, doc: "SSR layout stability" }),
    },
  },
];
