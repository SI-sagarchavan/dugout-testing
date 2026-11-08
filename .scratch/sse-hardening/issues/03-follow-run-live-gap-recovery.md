# 03 · A followed run reads its record again after a reconnect

Status: done (2026-11-08)
Type: task
Repo: frontend (`../wnm-fanxp-frontend`, `apps/surface-studio`)
Blocked by: none

## The problem

`src/entities/surface/api/follow-run-live.ts`, `followRunLive`. It reads the run's history once
(`readHistory`, the per-run endpoint with `?history=1`), then takes everything else from the feed
hub's `run.event` messages.

The feed is trimmed. The backend keeps about 20,000 entries per client
(`FEED_MAX_ENTRIES` in the backend's `src/services/surface-run/stream.ts`, `XADD MAXLEN ~`), and
every streamed token is one entry, for every run of the client. When the hub reconnects after
`Last-Event-ID` and that entry has been trimmed, Valkey returns what is left. Events in between are
gone from the feed without any error.

`use-feed-sync.ts` repairs the query cache on `ready { reconnected: true }`, but nothing repairs
`followRunLive`. If the lost part holds `run.completed`, the run's view never ends and keeps showing
it as live.

The per-run stream has no gaps: its entry ids are `0-<seq>` and it is kept for 7 days. So the
record is the right place to catch up from.

## The fix

In `followRunLive`, handle `{ type: 'ready', reconnected: true }` from the hub:

- If the follow has not caught up yet (`caughtUp === false`), do nothing: the first read is still in
  progress and the held events will be folded in.
- If it has ended, do nothing.
- Otherwise go back to holding: set `caughtUp = false`, call `readRecord()` again (it reads after
  the current `after`), then set `caughtUp = true` and deliver the held events through `deliver`,
  which drops anything at or below `after`.
- Never run two catch-ups at once: keep the one in flight as a promise and skip a second `ready`
  while it runs.
- `readRecord` sets `ended = true` on the record's `end` frame but doesn't call `finish()`. After a
  catch-up, if `ended` is true, call `finish()` so the outer `await done` returns `'ended'`.
- If the catch-up throws (after its own retries), end the follow with that error: the same as when
  the first read fails. The outer promise must reject, and `use-run-stream.ts` already turns that
  into `connection: 'failed'` with a retry button.

Keep `deliver` as the only place that calls `options.onEvent`.

## Tests

In `src/entities/surface/api/__tests__/feed.test.ts`, next to the existing `followRunLive` cases:

- The first record read gives seq 1–2. The feed gives seq 3, then the hub sends
  `ready { reconnected: true }`, the second record read gives seq 4–5 and `run.completed` at seq 6,
  and the feed then repeats seq 5. `onEvent` sees 1, 2, 3, 4, 5, 6 exactly once each, and the
  follow resolves `'ended'`.
- A `ready { reconnected: true }` before the first read finished doesn't start a second read
  (`readHistory` called once).
- The second read fails with a 404 `SurfaceApiError`: the follow rejects.

## Done when

- The new tests pass, and the existing feed tests still pass.
- `pnpm typecheck` and `pnpm lint` pass.

## Done

- Branch `fix/sse-03-follow-run-live-gap-recovery` (worktree `../wnm-fanxp-frontend-sse`), commit ea317bb25. Stacked on `fix/sse-00-wip-base` (snapshot of the then-uncommitted feed work).
- Checked: 3 new tests (failed before, pass now); `pnpm vitest --run src/entities/surface` 127 passed; `pnpm typecheck` and `pnpm lint` clean.
- Not checked: against a real backend with a trimmed feed.
