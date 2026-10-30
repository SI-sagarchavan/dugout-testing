# 09 · Cache code steps by their inputs

Status: ready-for-agent
Type: task
Blocked by: 02, 04

## What

A code step (04) whose inputs haven't changed returns its earlier result instead of running again. The key is the step's name, its input artifact ids and values, and a version the step declares. Results are artifact ids, so the cache is just a lookup table. Bumping the version invalidates old results.

The same mechanism lets a re-sent request redo only the parts that changed. In Figma to DSL, an unchanged section reuses its accepted result.

## Why

Expensive steps (rendering, compiling, large transforms) shouldn't repeat, within a run, across retries, or across re-sends of the same request.

## Done when

- A test runs the same step twice with the same inputs and executes it once. A bumped version runs it again.
- A re-sent run with one changed input reruns only the steps that depend on it.

## Pointers

- `apps/worker/src/run-store.ts`, `packages/db/migrations`
- Studio's simplest form of this: `trial/apps/surface-studio/server/plugin-api.ts` (`startCompile`, idempotent by export)
