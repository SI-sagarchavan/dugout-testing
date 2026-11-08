/**
 * Part 5 — Leaves (12).
 */

import { f, opt, req } from "../field.js";
import type { NodeSpec } from "./structural.js";

export const LEAF_NODES: NodeSpec[] = [
  {
    type: "Text",
    kind: "leaf",
    doc: "Orientation is named semantically, not after CSS writing-mode. The agent should not need to know `sideways-lr` exists, and native does not have it.",
    fields: {
      content: req(f.str()),
      // NOT Resp<>. @fanos/tokens already resolves type.* per breakpoint, so a
      // style ref is responsive on its own — see T3.
      style: req(f.token("type")),
      tone: opt(f.token("color")),
      align: opt(f.enum("start", "center", "end"), { resp: true }),
      truncate: opt(f.num(true), { doc: "max lines" }),
      orientation: opt(f.enum("horizontal", "vertical-up", "vertical-down")),
      /**
       * Figma's per-text-node case setting. It is a PRESENTATION choice, not
       * content: the design file stores "Ben\nMcKinney" and displays
       * "BEN MCKINNEY". Without this the only way to reproduce the design is to
       * uppercase the data, which corrupts the value for every other consumer.
       */
      textCase: opt(f.enum("none", "upper", "lower", "title")),
      /**
       * Figma's per-layer vertical trim. `cap` (the default) hugs cap-height to
       * baseline, which is what a file with "Vertical trim" on draws; `none`
       * keeps the full line box. Files differ — one design system trims every
       * layer, another trims none — so a renderer-wide choice is wrong for half
       * of them.
       */
      trim: opt(f.enum("cap", "none"), { doc: 'default "cap"' }),
      /**
       * `false` for Figma's auto-width text: one line that never wraps, with its
       * spaces kept. Without it a hugging label in a narrow absolute context
       * breaks at min-content ("view / all").
       */
      wrap: opt(f.bool(), { doc: "default true" }),
      as: opt(f.enum("h1", "h2", "h3", "h4", "h5", "h6", "p", "span")),
    },
  },

  {
    type: "RichText",
    kind: "leaf",
    doc: "Authored markup. `prose` styles the body copy inside it.",
    fields: {
      content: req(f.str()),
      style: req(f.token("type")),
      prose: opt(f.token("type")),
    },
  },

  {
    type: "Image",
    kind: "leaf",
    doc: "`placeholder` is an asset token rather than a free URL — an untracked URL is exactly the hand-maintained value this package exists to prevent.",
    fields: {
      src: req(f.str(), { doc: "image URL or binding — NOT the Figma node id" }),
      alt: req(f.str()),
      fit: req(f.enum("cover", "contain", "fill", "none")),
      position: opt(f.anchor()),
      ratio: opt(f.ratio()),
      scrim: opt(f.token("gradient"), { doc: "readability wash over the image" }),
      placeholder: opt(f.token("asset")),
      priority: opt(f.bool(), { doc: "eager-load above the fold" }),
    },
  },

  {
    type: "Icon",
    kind: "leaf",
    doc: "Named glyph from the icon set.",
    fields: {
      name: req(f.str()),
      size: opt(f.val()),
      tone: opt(f.token("color")),
    },
  },

  {
    type: "Button",
    kind: "leaf",
    doc: "`styleN` matches the `button_<variant>_style_N` token families.",
    fields: {
      label: req(f.str()),
      variant: req(f.enum("filled", "outline", "link", "no-padding")),
      styleN: req(f.literals(1, 2, 3)),
      size: req(f.enum("sm", "md", "lg")),
      iconStart: opt(f.str(), { doc: "a glyph's name, or a picture of it as a data URI" }),
      iconSize: opt(f.num(), { doc: "px, when it isn't the one this button size implies" }),
      iconEnd: opt(f.str()),
      action: req(f.action()),
      loading: opt(f.bool()),
      disabled: opt(f.bool()),
      /**
       * Fill the inline axis instead of hugging the label.
       *
       * The universal `size` object cannot say this on a Button: `size` is
       * already the sm/md/lg enum here, and a node's own field wins. So a
       * design's full-width submit — Figma's `sizing.w: "fill"`, which is what
       * every form's primary action uses — had no spelling at all, and compiled
       * to a pill the width of its label. On the fan-preferences page that was
       * a 710px SAVE bar rendering at 68px.
       */
      block: opt(f.bool()),
      /**
       * How the label is DISPLAYED, exactly as on `Text`.
       *
       * A button's label is a Figma text layer and carries the same case
       * setting, for the same reason: the file stores "save" and shows "SAVE".
       * Without this the only way to get the design's case is to uppercase the
       * label string, which is content, and which a translator would then have
       * to undo.
       */
      textCase: opt(f.enum("none", "upper", "lower", "title")),
    },
  },

  {
    type: "Link",
    kind: "leaf",
    doc: "Navigation that is not a button.",
    fields: {
      label: req(f.str()),
      href: req(f.str()),
      variant: opt(f.enum("inline", "standalone", "quiet")),
      iconEnd: opt(f.str()),
      external: opt(f.bool()),
    },
  },

  {
    type: "Tag",
    kind: "leaf",
    doc: "One Tag, not Badge + Chip. LIVE/RECENT and WOMEN/MEN are the same thing with different tones; two node types would be an encoding coin-flip for the agent.",
    fields: {
      label: req(f.str()),
      variant: req(f.enum("solid", "outline", "soft")),
      tone: req(f.token("color")),
      size: opt(f.enum("sm", "md", "lg")),
    },
  },

  {
    type: "Divider",
    kind: "leaf",
    doc: "A rule between things.",
    fields: {
      orientation: req(f.enum("horizontal", "vertical")),
      tone: opt(f.token("color")),
      opacity: opt(f.token("opacity")),
      inset: opt(f.val()),
    },
  },

  {
    type: "Countdown",
    kind: "leaf",
    doc: "Counts down to an instant.",
    fields: {
      to: req(f.str(), { doc: "ISO-8601 instant or binding" }),
      units: req(f.arr(f.enum("d", "h", "m", "s"))),
      labels: opt(f.bool()),
      onZero: opt(f.enum("hide", "hold")),
    },
  },

  /**
   * A field a person types in, where a design drew a box with a placeholder in it (the
   * newsletter's "Your Email Address"). It is a real `<input>`: focusable, typed in, filled by the
   * browser's autofill, sent with a form under `key`. Its box is the universal surface, space and
   * size, as drawn; the text in it is `style` and `tone`, the placeholder `placeholderTone`.
   *
   * What is typed is the page's under `key`, like a choice (`page.ts`): any section reads it as
   * `_page.<key>` in `when`, so a hint can show once something is typed.
   */
  {
    type: "Input",
    kind: "leaf",
    doc: "A text field a person types in: a real <input>, its box the universal surface, space and size. What is typed is the page's under `key` (`_page.<key>` in any `when`) and is its name in a sent form.",
    fields: {
      key: req(f.str(), { doc: "the page key it writes, read as _page.<key>, and its form name: letters, digits and _" }),
      kind: opt(f.enum("text", "email", "tel", "number", "password", "search", "url"), {
        doc: 'what is typed, which picks the keyboard and what the browser checks (default "text")',
      }),
      placeholder: opt(f.str(), { doc: "shown while it is empty" }),
      value: opt(f.str(), { doc: "what it starts with" }),
      style: req(f.token("type")),
      tone: opt(f.token("color"), { doc: "what is typed" }),
      placeholderTone: opt(f.token("color")),
      label: opt(f.str(), { doc: "its accessible name, when nothing on screen says it (default: the placeholder)" }),
      autocomplete: opt(f.str(), { doc: 'the browser\'s autofill hint: "email", "given-name", "tel" …' }),
      required: opt(f.bool()),
      disabled: opt(f.bool()),
    },
  },

  /**
   * A box a person ticks, where a design drew a small square beside a line of consent text. It is
   * a real checkbox, drawn in the design's look: its box is the universal surface and size, the
   * tick is drawn in `mark`, and while ticked it is in its `active` state (else `inactive`), so
   * `states.active` is the ticked box's look.
   *
   * Ticked or not is the page's under `key`: `_page.<key>` is "true" or "false" in any `when`.
   */
  {
    type: "Checkbox",
    kind: "leaf",
    doc: 'A box a person ticks: a real checkbox in the design\'s look. Its box is the universal surface and size, the tick is drawn in `mark`, and ticked it is in its `active` state (`states.active`), else `inactive`. `_page.<key>` is "true" or "false" in any `when`; `key` is also its form name.',
    fields: {
      key: req(f.str(), { doc: "the page key it writes, read as _page.<key>, and its form name: letters, digits and _" }),
      checked: opt(f.bool(), { doc: "ticked to start with (default false)" }),
      mark: opt(f.token("color"), { doc: "the tick's colour" }),
      markSize: opt(f.num(), { doc: "the tick's width in px, as drawn (default 10)" }),
      label: opt(f.str(), { doc: "its accessible name: what the text beside it says" }),
      value: opt(f.str(), { doc: 'what a sent form carries while it is ticked (default "on")' }),
      required: opt(f.bool()),
      disabled: opt(f.bool()),
    },
  },

  {
    type: "Tabs",
    kind: "leaf",
    doc: "A leaf, not a container. It renders toggle chrome and writes state; the panels it switches are elsewhere in the tree.",
    fields: {
      bind: req(f.str(), { doc: "state key this control writes" }),
      options: req(
        f.union(f.arr(f.obj({ value: req(f.str()), label: req(f.str()) })), f.str()),
        { doc: "literal options, or a binding that yields them" },
      ),
      variant: opt(f.enum("underline", "pill", "segmented")),
    },
  },
];
