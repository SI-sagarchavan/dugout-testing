# 08 · Cancel a run

Status: resolved
Type: task

## What

There's no way to stop a run today. A run that's queued, running or waiting can only finish, fail or be given up after crashes. Add cancelling:

- **The host side** (`apps/worker/src/queue.ts`) marks the run as cancelled. A new status, `cancelled`, with who cancelled it and why.
- **The worker** notices at its next save and stops. The run store's fence already stops an invocation that lost its lease, so this works the same way. It then writes a `run.cancelled` event so anyone following the run sees it end.
- **A queued or waiting run** is cancelled straight away, with no worker involved.
- **A run with tasks (04)** stops all of its tasks.
- **The CLI:** `pnpm agent --cancel <run id or its first characters> --tenant <t>`.
- **The ADR 0009 host contract** gains the cancel step.

## Why

Long runs (20 to 40 minutes) with real costs need a stop button. Hosts need one when a designer sends the wrong frame or closes the job. ADR 0009 lists it as not yet built.

## Done when

- Tests cancel a queued run, a waiting run and a running run, and each ends with `run.cancelled` and status `cancelled`.
- A cancelled run is never claimed again.
- The CLI command works.

## Pointers

- `apps/worker/src/queue.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/run-store.ts`
- `packages/contracts/src/events.ts`, `packages/db/migrations`, `apps/cli/src/main.ts`
