# 03 · Split a published frame into sections

Status: ready-for-agent
Type: task
Blocked by: 02

## What

Pure code in `packages/library`: from a published frame's IR, its DSL tree and its screenshot, produce candidate sections.

- Roots: the frame's top-level children, and every container layout detection names (ADR 0024, `agents/frame-match/src/layout.ts`), nested ones included.
- For each root: re-root the flat subtree (root's `parent` null, `idx` from 0), take the IR slice under it, compute the subtree signature, and cut the crop from the screenshot by the root's `renderBbox` (falling back to `bbox`), scaled by the screenshot's pixel ratio.
- Skip roots too small to be a section (a size floor in one constant) and roots with no visible content.
- Within one frame, repeats of one signature give one candidate.

## Done when

- On the frame-match eval frames, a test pins the sections each frame gives: their count, kinds of layout and signatures.
- Every crop's size matches its root's box within a pixel at the screenshot's scale.
- No filesystem or network inside the splitter; the caller passes bytes in and gets bytes out.
