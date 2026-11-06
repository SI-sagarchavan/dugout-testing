# 06 · dugout draws with @sikit/scre; packages/renderer and apps/web go

Status: on hold (2026-11-06: nothing is deleted until a person says so; the old renderers keep working)
Type: task
Blocked by: 01

## What

Finish the move. dugout's fidelity harness (`packages/renderer/src/harness`, `renderToPng`, `diff`,
`mapRegions`, the CLI), `packages/conform`, `apps/surface-studio`'s static preview and `apps/web` still use
dugout's renderer with its own `--fos-*` theme. The score frame-match reports must be measured on the
renderer pages use, with the tenant's CSS.

- The harness moves to (or stays in dugout and imports) `@sikit/scre`, and draws with
  `genCssFromJson` over the tenant's theme instead of `emitCss` over a token set. The harness's self-hosted
  fonts (`fonts.ts`) stay with the harness.
- How dugout gets the package: dugout pins the public registry (`.npmrc`) because the CodeArtifact token
  expires. Choose: CodeArtifact with a CI token, or a vendored build. Not a `link:` to a sibling checkout.
- `frame-match`'s and `data-bind`'s `previewUrl` point at Studio's queue item
  (`/#/<client>/surface-studio/queue/<sendId>`) instead of :3000 (`FANOS_WEB_URL`).
- Delete `apps/web`, then `packages/renderer` and the tests the package now owns. Re-baseline
  `agents/frame-match/evals/baseline.json` (`pnpm eval measure --write`) and say how much scores moved.
- CLAUDE.md, `docs/architecture/handoff-flow.md` and the `pnpm dev` script lose :3000.

## Done when

- `pnpm check` and `pnpm eval frame-match` pass with no `@fanos/renderer` left.
- The scores before and after are in this ticket's comments.
