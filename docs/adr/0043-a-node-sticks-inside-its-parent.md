# 0043: A node sticks inside its parent

Date: 2026-11-15 · Status: accepted

## Context

A design keeps some things in view while the page scrolls: a header that stays at the top, a side panel beside an article that follows the reader down and stops at the article's end. Figma says it on the layer ("Sticky", or "Fix position when scrolling"). The DSL had no way to say it. `place` pins an Overlay's child (`position: absolute`), and a Stack's `scroll` scrolls its own content. The plugin's IR did not record the setting, so the compiler never saw it.

CSS `position: sticky` does this, with two catches. A sticky element sticks only inside its parent's box. It also sticks to the nearest box that scrolls, and to a browser any box with `overflow: hidden` is one, though it never moves. Figma frames clip by default, so most compiled trees have `clip: true` on the root, and nothing inside such a tree would ever stick.

## Decision

- **`sticky: { edge?: "top" | "bottom", offset? }`** is a universal prop (`packages/dsl/src/universal.ts`), in the editor panel's Position group. The node sticks inside its parent's box, `offset` (a space token, default 0) from that edge of what scrolls. What scrolls is the page, or the nearest Stack with `scroll`.
- **On the tree's root, the whole section sticks to the page.** The root's box fills the renderer's `.fos-root` wrapper and could not move inside it, so the renderer puts `position: sticky` on the wrapper, which is the page's child.
- **A box that clips and holds a sticky node is drawn with `overflow: clip`.** That clips the same pixels without being a scroll container, so the node still sticks (`CLIP_HOLDS_STICKY` in `packages/renderer/src/resolve/style.ts`). What `hidden` also did is kept: a block box still starts its own formatting context (`display: flow-root`), and a flex or grid item's least size stays 0. Every other clip is unchanged, and the walk stops at a box with `scroll`.
- **S20** refuses what would never stick: a node in a Carousel's slides (Swiper moves and clips them), and `sticky` with `place.anchor` on one node.
- **IR 1.14.0** records `scroll: "sticky" | "fixed"` on a layer. The plugin reads it from the layer's `scrollBehavior` where Figma gives it, and otherwise from its frame's `numberOfFixedChildren` (the frame's last children are the fixed ones). The compiler turns Figma's sticky into `sticky: {}`. A fixed layer stays where it is drawn: at its frame's nearer edge (`bottom` for a bottom bar), that far from it. A layer placed by an anchor (in a frame without auto-layout) cannot stick: the compiler leaves `sticky` off and notes it (`sticky-dropped`).

## Consequences

- A sticky header section, and a side panel that sticks inside one section, are drawn from the tree alone.
- A side panel beside other sections, sticking until a later section, is page layout: the host's columns, not the DSL. The DSL keeps one tree per section.
- A host must not put a sticky section in a box of its own height (one wrapper per section), or the section sticks inside that box and never moves. `SurfaceSection` draws no box of its own.
- Nothing changes until the page scrolls, so screenshots, the pixel harness and the geometry gate see the design as before.
- A sticky node gets `z-index: 1` so later siblings do not paint over it.
- The plugin must be rebuilt and reinstalled for designers' Handoffs to carry `scroll`. Older IR has none, and nothing sticks until a person or an agent sets `sticky`.
- SCRE copies the DSL and the renderer (`pnpm scre:sync`). Studio draws `sticky` once it is synced, and its editor panels show it once `panels.generated.json` is generated again.
