# 20. The Figma-to-SDUI pipeline lives in this repo

The `card` and `card-match` agents ran the pipeline's compiler, DSL validator and renderer from a sibling `trial` checkout, found by `../trial` or `FANOS_TRIAL_ROOT`, and talked to its control plane and Studio. Two repos meant two installs, two lockfiles, and a change to the IR or the compiler that had to land in one repo and be built in the other before the agent saw it.

## Decision

The pipeline's packages and apps sit in `packages/` and `apps/` beside dugout's, as in any other part of this monorepo: `@fanos/{tokens,dsl,conform,compile,renderer,surface-canvas}` and `@fanos/{api,surface-studio,web}`. The npm scope says which family a folder belongs to. (They first landed in a `pipeline/` folder; that hid them from the repo's layout for no gain.)

- **One path.** The agents find the built packages from `REPO_ROOT`; `trialRoot()` and `FANOS_TRIAL_ROOT` are gone. They still import `dist`, so `pnpm build` runs after install and after a change there.
- **Own toolchain, for now.** The `@fanos/*` code keeps its tsup, vitest 2 and TypeScript 5 (each package pins its own) and its compiler options (`tsconfig.fanos.json`, less strict than `tsconfig.base.json`), and `biome.json` excludes it. Reformatting and stricter types were no part of the move, and can be done package by package.
- **Nothing renamed.** The `@fanos/*` names do not clash with `@dugout/*`, and the relative layout between an app and a package is the one the apps assume (the web app reads fixtures from `../..`).
- **Shared infra.** The control plane's database is `fanos` in dugout's Postgres server, its job queue is dugout's Valkey, and Electric is a service of the root `docker-compose.yml` (ADR 0021).

## Not moved

Git history (it stays in the `trial` remote), `native-preview/` (an Expo experiment that nothing imports), `skills-lock.json`, and the `.github` workflow.
