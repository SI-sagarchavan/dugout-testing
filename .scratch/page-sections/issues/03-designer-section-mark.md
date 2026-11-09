# 03 · A designer marks a section in the plugin

Status: done (2026-11-09)
Type: task
Blocked by: 02

## What

The designer can say "this layer is a section" (and "this layer is background") in the Figma
plugin, and the finder takes it over its own rules. Two ways, both read the same:

- a layer name starting `section/` (`section/squad`); `background/` for background;
- a designer note of a new kind, `section` (the Notes UI already has `must-do`, `data`,
  `behaviour`, `ignore`), with the slot's name as its text.

A mark may group layers that are not grouped in Figma: a note on several selected layers makes one
slot of them.

The plugin's Health tab flags a frame with more than one content band and no marks, as a hint, not
an error.

## Done when

- The IR carries the mark (`packages/surface-canvas/src/ir/schema.ts`), the plugin writes it, and
  the finder's tests show a mark overriding each of its rules.
- A Team case with marks (squad layers marked `section/squad`) gives the same answer as without.

## Pointers

- `packages/surface-canvas/src/annotations.ts`, `src/ui/Notes.tsx`, `src/ir/schema.ts`
- Rebuild `@fanos/*` after (`pnpm build`); the agents read its `dist`

## Done (2026-11-09)

- Plugin (`packages/surface-canvas`): note kinds `section` (its text is the section's name) and
  `background`, in the Notes kind picker; IR 1.13.0. Health: rule S2 `sections-unmarked`, a hint
  when two or more parts look like sections and nothing is marked, shown in the Check tab's Fix
  queue with a button to Notes.
- Finder (`packages/library/src/slots.ts`): `marksOf` reads layer names (`section/<name>`,
  `background`, `background/…`) and Section/Background notes; a mark on a layer inside a child of
  the frame marks that child; a child marked two ways keeps no mark. Marks come before every rule:
  layers marked with one name are one sure slot named as marked; an unmarked heading just above a
  marked part joins it.
- frame-match and data-bind skip Section/Background notes in their designer-notes lists: they are
  what the frame is made of, not requirements for the build.
- Tests: library `tests/slots.test.ts` (4), plugin `tests/rules.test.ts` (S2); the acceptance page
  now fires S2 too. `pnpm eval sections` has `team-marked`, the same answer as unmarked: 5 of 5.
- Not done: a note on several selected layers at once. The plugin pins a note to one layer; the
  same Section name on each layer does the same.
