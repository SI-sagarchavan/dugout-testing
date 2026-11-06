# 09 · @sikit/sdui-renderer becomes @sikit/scre

Status: done (2026-11-06)
Type: task
Blocked by: none

## What

`@sikit/sdui-renderer` was too close to `@sikit/renderer` (the page renderer), `@sikit/block-renderer` and
the `wnm-sdui-render-engine` repo. It is now SCRE, the Surface Core Render Engine: `@sikit/scre`.

- fanxp-web-renderer (worktree `../fanxp-web-renderer-sdui`, branch renamed `feat/scre`):
  `packages/sdui-renderer` → `packages/scre`; `SduiSection` → `SurfaceSection` (`SurfaceSectionProps`);
  the lockfile importer.
- wnm-fanxp-frontend: Studio's `link:` and imports, both Vite configs' `linkedPackageDir`, the lockfile.
- wnm-fanxp-backend: two doc comments.
- dugout: `.scratch/sdui-renderer` → `.scratch/scre`.

## Checked

- `@sikit/scre`: 235 tests pass, `tsup` builds.
- Studio: 341 tests pass, `tsc -b` clean, `pnpm install --frozen-lockfile --offline` passes.
