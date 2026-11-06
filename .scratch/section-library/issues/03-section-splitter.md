# 03 · Find a frame's sections from its IR

Status: in progress
Type: task
Blocked by: 02

## What

Pure code in `packages/library` (`findSections`): from a Handoff's IR, its plates' sizes and layout detection's answer, the sections and where each one's picture is.

- A page's sections are its full-width children; a frame with fewer than two is one section, itself. A lone child filling its parent is looked through.
- Inside each, every container `detectLayout` names (ADR 0024) is a section one level down.
- Each section's picture: its own plate, or cut from the nearest plate around it at that plate's scale, by the root's `renderBbox` (else `bbox`). Art plates (`art-…`) only for their own layer.
- One section per signature within the frame; the signature function is passed in (the IR's `computeStructuralSignature` at full depth, from the built `@fanos/surface-canvas`).
- What is left out says why: too small, a single layer, the same shape as another, no picture covers it, a picture that does not line up.

## Done when

- On the frame-match eval frames and held-out designs (`agents/frame-match/evals/frames.ts`), a test pins the sections each gives: count, level, layout and why any were left out.
- Every cut matches its root's box within a pixel at its plate's scale.
- No filesystem or network inside it.

## Comments

2026-11-06: `findSections` and its tests on synthetic IR are in (`packages/library/src/sections.ts`, `tests/sections.test.ts`): bands in order, sub-sections, own plate first, wrapper looked through, single-section frames, repeats, art plates, shadows. Left: pinning it on the real eval frames, which needs the control plane up to read them (or their IR and plates saved as fixtures).

2026-11-06: tried on the 20 latest local Handoffs (`pnpm agent library index --latest 20`). Two changes came from that. A section with no plate of its own or around it gets a picture put together from the plates of the layers inside it, when they cover 90% of it (the header `e02bac4a…` arrives as two bars and a logo). And a band must hold layers: full-width images and shapes are backgrounds (`d_showcase` had been split into three empty layers). One section was left out for want of any picture (`Showcase` in `container`, `0b5df7e3…`).
