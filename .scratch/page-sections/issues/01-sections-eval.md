# 01 · The Team frame as a sections eval case

Status: done (2026-11-09): `pnpm eval sections`, 0 of 3 right as expected; container and Fixtures cases not added yet
Type: task
Blocked by: none

## What

A code-only eval, like `pnpm eval layout`: `pnpm eval sections` runs the section finder over each
case's IR (no model) and compares it with the expected answer; exits non-zero on any miss.

First case, the `Team` frame (Figma 35:10501, export `1b10c408-e76d-4407-9282-ab2dee825d4e`, IR
artifact `c9da02a0-8c1c-4c58-b49f-f2a643d0f97f`, file in `apps/api/.blobs/`). Copy the IR into the
eval's fixtures (it is the source of truth for the case, the control plane is not).

Expected:

- background: `35:10502` (`D_Team`)
- slot `fixtures`: `35:10541` (heading row, carousel, View more)
- slot `squad`: `35:10512` (heading, WOMEN/MEN tabs, View more), `35:10529` (cards), `35:10526`
  (arrows); its tabs write a page choice the cards read
- one band (the frame), since the background spans both slots

Add the other multi-section frames already in the control plane as cases when their answer is
clear (`container` 35:9853, `Fixtures` 1:6213), and two one-section frames (`LATEST NEWS`,
`Videos`) that must come back as one slot.

## Done when

- `pnpm eval sections` exists, reads `agents/frame-match/evals/sections.ts` (or the library's
  evals), prints each case's diff, and fails today on `Team` with the four-way split from the spec.
- It is in the list in CLAUDE.md's Commands.

## Pointers

- `packages/library/src/sections.ts` `findSections` (today's finder), `agents/frame-match/evals/layouts.ts` and the `eval layout` script (the pattern to copy)
- Today's result on Team: `D_Team`, `35:10541`, `35:10512`, `35:10529`; `35:10526` skipped as too small
