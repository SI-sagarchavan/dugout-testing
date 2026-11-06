# 01 · Publish @sikit/scre and replace the link

Status: ready-for-human
Type: task
Blocked by: none

## What

Studio depends on the package through `link:` to a local worktree. Nothing outside this machine can
install that. Publish it to CodeArtifact the way the other `@sikit` packages are (changeset, `pnpm co:login`,
`pnpm publish-library` in fanxp-web-renderer), then depend on a version.

- Commit `packages/scre` on `feat/scre` and open the PR against `development`.
- Add a changeset (`0.1.0`).
- In wnm-fanxp-frontend: `"@sikit/scre": "^0.1.0"` and `"@sikit/utils": "^5.2.0"` in
  `apps/surface-studio/package.json` (the latter is used by `use-tenant-theme.ts` and resolves only by
  hoisting today).
- Remove `linkedPackageDir` from `apps/fanxp/vite.config.ts`, `apps/surface-studio/vite.config.ts` and
  `vitest.config.ts`.
- Delete the leftover `packages/molecules/block-rendererv2` folder (no source, only `dist/` and `node_modules`).

## Done when

- `pnpm install --frozen-lockfile` passes in wnm-fanxp-frontend with no `link:`.
- Studio's tests pass and the canvas still draws at :5555.
- The production build imports `dist/` (the `import` condition), not `src/`.
