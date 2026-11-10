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
- **What the frame shows is applied without asking; what it cannot show is asked.** In `frame-match`, `frame.load` applies `certain` carousels. A layout with questions goes through `frame.layout`, a write tool and so an approval. The reviewer reads a question card (what the frame showed, what it cannot show, what is proposed) and approves, or requests a change in plain words, which the model turns into the choice. `frame.publish` is refused until each question has been asked once. The model never decides a layout.
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

- `pnpm eval layout` scores detection on the 18 eval frames against `agents/frame-match/evals/layouts.ts`. The rules were tuned on those frames, so this is a regression check, not held-out accuracy. An unlabelled carousel is a failure.
- None of the eval frames has designed pagination dots, so the dots rule is checked only on hand-built IR until a real design has them.
- A run with `--yes`, or `pnpm agent watch` without `--ask`, approves every proposal as it stands. Unsure rows stay rows and carousels get no autoplay or loop.
- Lowering a carousel did not move a pixel on any of the four eval frames that have one (player-strip, team-page, fixtures-strip, fixtures-inner): the match and conform errors are identical with and without it.

## Amendment (2026-11-10): the frame is read by eye first; the detector is evidence

**Context.** Handoff `9498f86c` (Southern Brave, "Showcase") is a hero carousel of stories: one story drawn, two arrows, a "01" counter and a thin progress bar, with a match card pinned on it. `detectLayout` starts from two or more matching siblings, found one slide, and proposed nothing; nobody was asked, and data-bind bound a single article. A person sees the carousel at once. The detector's weights and thresholds were code deciding what a frame is for, which the model should do (questions from the model, not code).

**Decision.**

- **`frame.load` reads the frame first** (`agents/frame-match/src/read.ts`). A vision model (`FRAME_MATCH_READ_MODEL`, Sonnet by default; `FRAME_MATCH_READ=off` leaves it out) gets the design as one picture and an outline of its layers, each with a handle (`h12`), its type, name, box and text. It answers what the section is for (`experience`), its `parts`, each container's behaviour (carousel, tabs, list, grid, row) with its items, the one slide it draws when it draws only that one, and its controls (prev, next, dots, counter, progress), how sure it is, and what the picture cannot settle (`unsure`). It names layers only by handle.
- **The IR places and checks every claim.** Handles map to Figma ids. Items must be siblings; a slide's layers are lifted to the children of the container they share; an arrow is at most 96px, read prev-then-next by position (not by its layer or glyph name); a counter is a text with a digit; a progress bar is at most 8px thick; dots are two or more children. What fails is reported (`notBorneOut`) and never applied. What `detectLayout` sees of the same container is added as evidence (`the IR: …`), and its geometry (centring, the first slide) fills a carousel's config; a carousel or tabs it is sure of that the reading left out becomes an open `kind` question. It decides nothing on its own.
- **Applied unasked only when the eyes are sure and the IR bears it out** (reading `sure` ≥ 0.75 and backed). Otherwise the layout is `unsure`, and its `kind` is an open item the agent settles from memory, from the evidence, or by asking. The layout judge (a text model asked about doubtful rows) is gone: the reading replaces it.
- **A choice carries its structure** (`@fanos/dsl` `layoutChoiceSchema`): `items`, `slide` and `chrome` (now with `counter` and `progress`), so lowering no longer re-detects and a person or the model can change which layers are the slide. A choice kept from before, without them, is lowered from `detectLayout` as before.
- **A carousel that draws one slide** (`slide`) is lowered by wrapping those layers, a run in one Overlay, into one slide of a new `Carousel` that fills the container (`synthetic:` srcs); each layer keeps its place, so the first paint is the frame. Arrows and the counter are wired with `controlFor` (the counter in the drawn form: "01" is `0{index}`); the progress bar stays as drawn, because the renderer fills a bar by scale and this design moves a segment. data-bind sees the slide as a list of one (`groups` … `oneSlide`) and collapses it over the data; `applyBindingPlan` folds a single member under a `Carousel`.
- **The slot finder takes the reading's groups**: a slide's layers are one slot and never background, so the story's photo is bound with its words.
- **When the frame cannot be read** (the model is down or answers no usable JSON) the run goes on: what the IR shows is put to the agent, every carousel and tabs as an open `kind`, nothing applied unasked.

**Consequences.** One vision call per Handoff (a few cents on Sonnet). Runs are less deterministic, so `pnpm eval read` scores the reading against `evals/layouts.ts` (Showcase added, its IR and design picture in `evals/sections/`) and `--repeat` counts a label right only when every read gets it. Its first run was 6 of 13; what it showed is now code:

- the eyes leaning one way (0.5 or more) and the IR certain of the same kind on the same container apply it: two signals that do not share a mistake agree;
- a carousel or tabs read on a band whose items the IR cannot name is the IR's container of that kind inside it (the eyes say what, the IR says where);
- a grid the IR lays on one line is a row (or a list);
- the IR's lists and grids the reading did not name are kept as evidence that the section shows data;
- a model's `null` is read as left out.

With those, 13 of 13 on every one of three reads (Sonnet). `pnpm eval layout` still scores the detector (12 of 12): it now also groups three or more siblings a person named alike and drew the same size (ho-spider's graph switch), and three toggles the old labels left out are labelled.
