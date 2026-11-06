# 15 · Previewed sections

Status: in progress
Type: task
Blocked by: 05, 13

## What

A section enters the shared pool when a preview is built from a Handoff it is in: when a frame-match or section-builder run completes with a `previewUrl`.

- `syncPreviews`: the tenant's completed preview runs (input `handoffId` or `exportId`), the Handoff indexed first when the library has not seen it (FanXP backend or control plane), then `markPreviewed`: `previewed_at` the first preview's time, every run in `previews`, each counted once.
- `pnpm agent library previews --tenant <t> [--no-caption] [--reindex]`.

## Done when

- Running it twice changes nothing the second time.
- The worker does it after every completed frame-match and section-builder run, so no one has to run a command.

## Comments

2026-11-06: `syncPreviews` and the command are in (`src/previews.ts`, `scripts/previews.ts`), with a test on runs rows. Live on `sb`: 6 preview runs of 2 FanXP Handoffs, both read from the backend and indexed with captions, 3 sections previewed. Left: the worker calling it after each preview run (an `afterRun` needs the library in the SDK's deps, or a worker-side step after a run completes).
