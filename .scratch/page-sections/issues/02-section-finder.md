# 02 · Section finder: background, bands and slots

Status: done (2026-11-09): `findSlots` in `packages/library/src/slots.ts`; `pnpm eval sections` 4 of 4 (Fixtures 1:6213 added); library tests 59 pass
Type: task
Blocked by: 01

## What

One pure function, used by the section library and by frame-match, that says of a frame:
`{ background: nodeId[], bands: [{ id, nodes, slots: [{ id, name, nodes, layout }] }] }`, every
node in at most one slot.

Rules, each with a test:

0. **Slots are made of the band's children, never the band itself.** A one-section frame
   (`LATEST NEWS` 35:10231, one child `35:10232`) is a band whose one slot is that child; the
   frame's own fill is the band's paint, not a layer.
1. **Background.** A full-width child whose subtree is only pictures, vectors and masks (no text,
   no instance of a component) is background, at any depth it is wrapped (`D_Team` → mask group →
   pictures). So is a full-width shape alone, also when it reaches past the frame's edges
   (`Videos`' `Vector 100`, 35:10612, is at y −118 and 630 tall in a 512-tall frame).
2. **Heading joins content.** A short band (under ~80 px, holds text, tabs or a button) joins the
   nearest content band below it, when the gap between them is smaller than the gap above it.
3. **Controls join.** A child too small to be a section (arrows, a pager) joins the slot whose
   vertical range holds it, or else the nearest slot above it, when the gap up to that slot is
   smaller than the gap down to the next one. (Team's arrows `35:10526` sit at y 914–954, below
   the card row's 467–879: outside its range, so "range holds it" alone drops them.)
4. **Grouped is kept.** A child the designer grouped that holds both a heading and content is one
   slot as it is (`35:10541`).
5. **Bands.** Slots under one background are one band. Slots with no shared background, or each
   with their own, are bands of their own.
6. **Names.** A slot's name is its heading's text, slugged (`the-brave-squad`), else its layer name.
7. **Confidence.** Each slot says `sure` or `unsure` and why (ticket 04 asks about `unsure`).
   `unsure`: two content bands with no heading between them; a heading with no content under it.

The library's indexer keeps level-1 containers (carousel, grid, tabs) as it does now, under the
slot that holds them.

## Done when

- `pnpm eval sections` passes on every case of ticket 01.
- The library's tests still pass; `library index` on the Team Handoff indexes two slots, not four
  sections and a background.
- frame-match can import it (no picture work in it: pictures stay in the library's indexer).

## Pointers

- `packages/library/src/sections.ts` (move the structural part out; `cropFor` stays)
- `FULL_WIDTH` 0.8, `MIN_SECTION_WIDTH` 120, `MIN_SECTION_HEIGHT` 40
- Layout detection: `@fanos/compile` `detectLayout` (ADR 0024)
