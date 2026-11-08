# 15 · Previewed sections

Status: resolved
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

2026-11-07: the worker does it. `createWorker` takes `onCompleted`, called once a run completes, after its lease is let go; a throw goes to `onError` and never fails the run, and `idle`/`stop` wait for it (tested in `apps/worker/tests/worker.test.ts`). `apps/worker/scripts/work.ts` hands it `libraryFollowUp`: for a frame-match, section-builder or data-bind run, `syncPreviews` for that run alone. data-bind runs count too: their input is a preview, and their Handoff is the one the run that published that tree read. `LIBRARY=off` leaves it out; `LIBRARY_CAPTION_MODEL` names the captioner (haiku, or `off`). Live on `sb`: 29 preview and binding runs, 12 newly counted; 8 runs' Handoffs are no longer on the FanXP backend, so their sections are shared but could not be read again.
