# 0024 — Layout detection: inferred from the frame, asked of a person for the rest

Date: 2026-11-03 · Status: accepted · Extends ADR 0019

## Context

The compiler draws what a Figma frame shows, and a frame is one picture. A carousel in a frame is a row of cards cut off by a clipping edge, so it compiled to a clipped Stack, and the pixel match was perfect. The measure cannot catch this: a static screenshot of a carousel _is_ a clipped row. Tabs, scrolling lists and grids have the same problem.

The pipeline serves one DSL per device: the host's page URL asks for desktop, tablet or mobile, and a mobile Figma frame compiles to the mobile tree. So a container's layout is decided for the one frame being compiled, never as breakpoints inside a tree.

## Decision

- **Detection reads today's export, nothing new.** `@fanos/compile` `detectLayout(doc)` walks the Frame IR and proposes a `LayoutIntent` (`@fanos/dsl`) per container of repeated items:
  - **Items** are siblings of one component (instances of one name, whose variants differ) or one shape (`canonicalSignature`). Art (logos, crests, glyphs) and rules between items are not items.
  - **Arrangement** comes from geometry: one row, one column, or a grid aligned on both axes.
  - **A carousel is `certain`** on any one of: an item cut off by the clip edge while another is on show; a designed previous or next arrow (by the glyph inside it, since designs name both buttons `back/next`); a row of three or more dots with one drawn differently. The dot count is the page count. Cards cut off on both edges around one in the middle of the clip make a centred carousel that starts on that card.
  - **Tabs** are a row of single-label items where exactly one is drawn differently. `certain` when the layers are named as tabs.
  - **A row of cards that exactly fills its container is `unsure`**: a fixed row, or a carousel that only moves when there are more. The frame cannot tell.
  - Each intent lists its evidence in plain words, and in `ask` the questions the frame cannot answer, with the default the proposal already uses.
- **What the frame shows is applied without asking; what it cannot show is asked.** In `card-match`, `frame.load` applies `certain` carousels. A layout with questions goes through `frame.layout`, a write tool and so an approval. The reviewer reads a question card (what the frame showed, what it cannot show, what is proposed) and approves, or requests a change in plain words, which the model turns into the choice. `frame.publish` is refused until each question has been asked once. The model never decides a layout.
- **A decided layout is an override** (`Overrides.layouts`, a `LayoutChoice` keyed by the container's Figma id), so a rebuild or a resumed run applies it again.
- **Lowering is code and keeps the first paint.** `@fanos/compile` `lowerLayout(tree, doc, choices)` rewrites the compiled Stack:
  - The Stack becomes a `Carousel` with the same slides.
  - Its inline padding becomes Swiper's offsets.
  - A row that bleeds past its own box gets `clip: false`.
  - A centred row drawn wider than its clip takes the clip's width, with `centerAt` for the server's first paint and a C2 waiver for the box that moved on purpose.
  - `frame.load` keeps a lowering only if the measured match and conform errors are unchanged. One that moves pixels is left out, with a note.
- **Controls are nodes, and the renderer draws none.** A drawn arrow or dot row keeps its look and is wired to its carousel with the universal prop `controlFor: { target, part }` (S16). What a frame cannot draw, a look in a state (an arrow with nowhere to go, the current page's dot, a slide not on show), is the node's `states`, in tokens. Lowering gives designed arrows `states.disabled` (`opacity.40`) unless the config gives one. `controls.arrows.placement: edges` spreads a row of the two arrows to the carousel's edges (`justify: between`, prev first). (This replaced renderer-drawn `controls` and its CSS: a carousel's look had to be any look, so it is the tree's.)
- **A platform config fills what the frame cannot show.** `fromPlatformCarousel` reads the platform's JSON into Carousel props (behaviour and motion) and per-control looks in each state. The frame wins on what it shows. Controls the design did not draw are not drawn: the config names them by `variant` number, with nothing to draw them from, and the run says so.
- **The renderer draws the first paint; Swiper takes it over.**
  - `Carousel` is a Server Component. It draws the gap, the offset before the first slide and a centred active slide from CSS custom properties, so a screenshot and a visitor without the script see the design.
  - `@fanos/renderer/client`, its own build entry with `"use client"`, mounts Swiper on the same elements, reading token values as computed style. Once Swiper runs, `data-fos-swiper` turns the first-paint rules off.
- **Tabs and grids are detected and recorded, not lowered yet.** A note says so. The DSL's `Tabs` draws its own chrome and would lose the designed tab bar.

## Consequences

- `pnpm eval layout` scores detection on the 18 eval frames against `agents/card-match/evals/layouts.ts`. The rules were tuned on those frames, so this is a regression check, not held-out accuracy. An unlabelled carousel is a failure.
- None of the eval frames has designed pagination dots, so the dots rule is checked only on hand-built IR until a real design has them.
- A run with `--yes`, or `pnpm agent watch` without `--ask`, approves every proposal as it stands. Unsure rows stay rows and carousels get no autoplay or loop.
- Lowering a carousel did not move a pixel on any of the four eval frames that have one (player-strip, team-page, fixtures-strip, fixtures-inner): the match and conform errors are identical with and without it.
