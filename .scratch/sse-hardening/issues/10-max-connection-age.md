# 10 · A maximum age for each connection

Status: done (2026-11-08)
Type: task
Repo: backend (`../wnm-fanxp-backend-surface-auth`)
Blocked by: 05 (and 08 if it has landed: use its `openSseStream`)

## The problem

The stream routes check the token and the `Surface:send` permission once, in the `preHandler`, when
the connection opens. The feed then stays open for as long as the tab does: hours, or days. A person
whose access was removed, or whose token expired and was never refreshed, keeps receiving every
run's events for the client.

Long connections also stay pinned to the task they opened on. After scaling out, the new tasks get
no streams until the old ones restart.

## The fix

Close each stream after a maximum age, cleanly, so the client reconnects through the normal path:
the axios client refreshes the token on a 401, and `authenticate` and `routePermission` run again.

1. `src/services/surface-run/config.ts`: `export const MAX_STREAM_MS = 20 * 60_000;`
2. When a stream opens, set a timer for `MAX_STREAM_MS` plus a random ±10 %, so connections opened
   together don't all close together. When it fires, abort the stream. Clear it in `finally`.
3. Closing at max age is not an error: write nothing, not `stream-error` or `end`. `end` would tell
   the per-run reader the run is over, which it isn't.

Check the Studio handles it, by reading the code, not changing it:

- `api/feed.ts`: a stream that ends cleanly reconnects after `Last-Event-ID`.
- `api/follow-run.ts`: a stream that ends without `end` counts a failure and reconnects; heartbeats
  reset the failure count, so a 20-minute stream never comes near `maxFailures`. Confirm this, and
  note it under `## Done`.

## Tests

Route or controller test with jest fake timers: a stream that would run for ever ends once the
timer passes `MAX_STREAM_MS × 1.1`, with no `stream-error` or `end` frame written.

## Done when

- The test passes; `tsc` and eslint pass.
- The two client readings above are recorded under `## Done`.

## Done

Branch `fix/sse-10-max-connection-age` (from sse-08), commit 93a50d89. `MAX_STREAM_MS` (20 min) in config.ts; `openSseStream` sets a timer of MAX_STREAM_MS x (0.9..1.1) that aborts the stream and clears it in `done()`. Abort writes nothing (no stream-error, no end). Route test with fake timers: still open at 0.89x, ended by 1.11x with no stream-error/end; it fails with the timer disabled (checked). jest 66 pass, tsc and eslint clean.
Client readings (code only, no changes): api/feed.ts: when the stream ends cleanly `reader.read()` returns done, `readConnection` returns, the loop counts a failure, sleeps and re-opens with `after` (last run.event id); `failures` resets to 0 on every successful open, so it reconnects indefinitely. api/follow-run.ts: a stream ending without `end` makes `readConnection` return false, so `failures` is incremented and it reconnects after `after`; `handle()` sets `failures = 0` for every frame including heartbeat comments, so a 20-minute stream never approaches `maxFailures`. Confirmed as stated in the ticket. The token refresh on 401 at reconnect was not traced.
