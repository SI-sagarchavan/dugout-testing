# 08 · Backend stream hygiene

Status: done (2026-11-08)
Type: task
Repo: backend (`../wnm-fanxp-backend-surface-auth`)
Blocked by: 05 (it moves these writes into `sse.ts`)

Three small things in `src/controllers/surface-run/` (after 05, mostly `sse.ts`).

## 1. `stream-error` sends internal error text to the browser

Both stream controllers write `event: stream-error` with `data: {"message": error.message}`. That
message can be an ioredis or Postgres error (host names, key names, SQL). Send
`{"code":"stream_failed"}` instead. The full error is already logged with `fastify.log.error`;
also log the route, run id and client there.

The Studio ignores `stream-error` (`api/feed.ts` default branch; `follow-run.ts` fails to parse it
as an event and skips it), so nothing in the frontend changes. Check this with a search for
`stream-error` in `../wnm-fanxp-frontend/apps/surface-studio/src`.

## 2. `retry: 2000` has no effect

`startSse` writes `retry: 2000`. Only the browser's `EventSource` reads that field; the Studio uses
`fetch` and its own backoff. Keep the line (it helps anyone who connects with `EventSource` or
`curl`), and add a comment saying the Studio's backoff is in `api/backoff.ts` in the frontend.

## 3. Heartbeat and stream setup in one place

Both controllers set up the abort controller, the `close` listener, the heartbeat interval and the
tracking from ticket 04 in the same way. Move that into one helper in `sse.ts`,
`openSseStream(reply, log): { abort, write, done() }`, where `done()` clears the heartbeat, untracks
and ends the response. Then use it from both controllers. Behaviour must not change: the existing
route tests are the check.

## Tests

- Route test: a stream whose follow throws gets `event: stream-error` with `{"code":"stream_failed"}`
  and not the error's message.
- The rest are covered by the existing route tests and 05's tests.

## Done when

- The tests pass; `tsc` and eslint pass.

## Done

Branch `fix/sse-08-backend-stream-hygiene` (from sse-05), commit a0816e44. (1) stream-error now sends `{"code":"stream_failed"}`; the error is logged with route, client and (events) run id via a child logger. (2) comment on `retry: 2000` pointing at the frontend's backoff. (3) `openSseStream(reply, log) -> { abort, write, done }` in sse.ts used by both controllers (abort, close listener, guarded writer, heartbeat, tracking, end). Frontend search for `stream-error`: only a comment in api/feed.ts:145 saying it is ignored/reopened; nothing parses it (follow-run.ts has no reference; I did not trace its parse-failure path beyond that). Tests: 2 new route tests (events and feed) failed before, pass now. jest 65 pass, tsc and eslint clean.
