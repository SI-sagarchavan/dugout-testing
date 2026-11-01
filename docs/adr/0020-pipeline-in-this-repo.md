# 20. The Figma-to-SDUI pipeline lives in this repo

The `card` and `card-match` agents ran the pipeline's compiler, DSL validator and renderer from a sibling `trial` checkout, found by `../trial` or `FANOS_TRIAL_ROOT`, and talked to its control plane and Studio. Two repos meant two installs, two lockfiles, and a change to the IR or the compiler that had to land in one repo and be built in the other before the agent saw it.

## Decision

The pipeline is `pipeline/` in this repo: the `@fanos/*` packages (`tokens`, `dsl`, `conform`, `compile`, `renderer`, `surface-canvas`) and apps (`api`, `surface-studio`, `web`), as they were in `trial`. They join the pnpm workspace as `pipeline/packages/*` and `pipeline/apps/*`.

- **One path.** `PIPELINE_ROOT` in `@dugout/core` replaces `trialRoot()` and `FANOS_TRIAL_ROOT`. The agents still import the built `dist` of the pipeline packages, so `pnpm pipeline:build` runs after install and after a change there.
- **Own toolchain, not ours.** `pipeline/` keeps its tsup, vitest 2 and TypeScript 5 (each package pins its own), and `pnpm check` lints it with neither Biome nor dugout's TypeScript settings. Reformatting it was no part of the move.
- **Nothing renamed.** The `@fanos/*` names do not clash with `@dugout/*`. The relative layout inside `pipeline/` is the one the apps already assume (the web app reads fixtures from `../../..`), so the card agent still writes its preview to `pipeline/packages/{dsl,renderer}/fixtures/preview/`.
- **Separate infra.** The control plane's Postgres, Redis and Electric stay in `pipeline/apps/api/docker-compose.yml` (:5433, :6379, :3010), apart from dugout's (:55432, :56379).

## Not moved

Git history (it stays in the `trial` remote), `native-preview/` (an Expo experiment that nothing imports), `skills-lock.json`, and the `.github` workflow, which does nothing in a subfolder.
