# 14 · @sikit/renderer passes over a surface_section template

Status: done (2026-11-06)
Type: task
Blocked by: none

## What

fanxp-web-renderer `packages/renderer`, additive only (nothing removed or changed for any other content
type):

- `constants/mappers.ts`: `SURFACE_SECTION_CONTENT_TYPE = "surface_section"`, added to
  `NON_KMP_CONTENT_TYPES`, so a published page with one does not fetch KMP data for it.
- `query-engine.tsx`: renders nothing for it (beside the `dynamic_block` branch).

Ticket 03 replaces the nothing with `<SurfaceSection>`.

## Checked

- Two tests in `__test__/page/query-engine.test.tsx`. Renderer suite (run from the repo root, which has
  the jsdom config): 1003 pass, 1 fails: `workflow-hydration.test.ts` "falls back to
  getKmpImageVersion()", which fails the same on `development` without this change. `tsc` clean.
- The suites needed the workspace packages built first (`pnpm --filter "@sikit/renderer^..." build`).
