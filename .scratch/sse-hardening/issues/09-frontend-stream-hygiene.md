# 09 · Frontend stream hygiene

Status: done (2026-11-08)
Type: task
Repo: frontend (`../wnm-fanxp-frontend`, `apps/surface-studio`)
Blocked by: 03 (same function), 06 (`backoff.ts`)

Two small things in `src/entities/surface/api/follow-run-live.ts`, `readRecord`.

## 1. One malformed frame retries the whole history read

Line ~88: `WireEventSchema.safeParse(JSON.parse(sse.data))`. `JSON.parse` throws on bad JSON. The
throw is caught by the retry loop, which reads the whole record again, up to three times, and then
fails the follow.

`follow-run.ts` already has `parseEvent(raw)`, which returns `null` on bad JSON or a schema miss.
Export it and use it here; skip a frame it returns `null` for, like `follow-run.ts` does.

## 2. The history retry wait can't be cancelled

Line ~103: `await new Promise((resolve) => setTimeout(resolve, HISTORY_RETRY_MS * attempt))`. If the
user leaves the run during that wait, the timer still runs and the next attempt starts before the
loop sees the abort.

Use `abortableSleep(ms, abort.signal)` and `retryDelay(attempt, { baseMs: HISTORY_RETRY_MS, maxMs: 4_000 })`
from `api/backoff.ts` (ticket 06), and return straight after the sleep if the signal aborted.

## Tests

In `src/entities/surface/api/__tests__/feed.test.ts`:

- A record with a frame `data: {not json` between two good events: both good events are delivered,
  and `readHistory` is called once.
- Abort during the retry wait after a 500: `readHistory` isn't called again and the follow resolves
  `'aborted'`.

## Done when

- The tests pass; `pnpm typecheck` and `pnpm lint` pass.

## Done

- Branch `fix/sse-09-frontend-stream-hygiene` (worktree `../wnm-fanxp-frontend-sse`), commit 2d9f9d121, stacked on the previous sse branch (base: `fix/sse-00-wip-base`).
- Checked: 2 new tests (failed first, then pass); `pnpm vitest --run src/entities/surface` 140 passed; typecheck and lint clean.
