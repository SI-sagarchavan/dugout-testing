# 03 · A designer marks a section in the plugin

Status: ready-for-agent
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
