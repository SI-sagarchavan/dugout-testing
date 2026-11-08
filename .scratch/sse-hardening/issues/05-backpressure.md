# 05 · Drop a client that cannot keep up

Status: done (2026-11-08)
Type: task
Repo: backend (`../wnm-fanxp-backend-surface-auth`)
Blocked by: 04 (same controller)

## The problem

`src/controllers/surface-run/index.ts` writes every frame with `reply.raw.write(...)` and ignores the
return value. `write()` returns `false` when the socket's send buffer is full; Node keeps buffering
whatever else you write, in memory, with no limit.

A client that reads slowly (a phone on a weak network, a laptop that went to sleep with the tab open
and the TCP connection not yet timed out) while runs stream tokens makes the process hold everything
not yet sent. The feed carries every token of every run of the client, so one slow tab can grow the
heap by megabytes a minute.

Writes also happen after the socket closed: the heartbeat interval and the stream callbacks don't
check whether the response is still writable.

## The fix

Don't wait for `'drain'`: the stream callbacks are synchronous, and holding a slow client's place in
Valkey is what `Last-Event-ID` already does. Drop the connection instead, and let the client
reconnect from the last id it received.

1. `src/services/surface-run/config.ts`: `export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;`
2. New `src/controllers/surface-run/sse.ts`, with `createSseWriter(raw: ServerResponse, abort: AbortController, log)`
   returning `write(chunk: string): void`:
   - if `raw.destroyed || raw.writableEnded`, do nothing;
   - otherwise `raw.write(chunk)`; then if `raw.writableLength > MAX_STREAM_BUFFER_BYTES`, log a
     warning once (the route, the client, the buffered bytes), `abort.abort()` and `raw.destroy()`.
     Destroying drops what was buffered; ending would try to send it.
3. Move `startSse`, `SSE_HEADERS` and the `frame` helper into `sse.ts` too, and use the writer for
   every write in both stream controllers: frames, heartbeats, `end`, `stream-error`.
4. The `finally` still calls `raw.end()`; on a destroyed response that is a no-op. Check that.

## Tests

`tests/controllers/surface-run.sse.test.ts`, with a fake `ServerResponse` (an object with `write`,
`destroy`, and settable `writableLength`, `destroyed` and `writableEnded`):

- Writes pass through while under the limit.
- The write that takes `writableLength` over the limit aborts the controller and destroys the
  response; later writes do nothing; the warning is logged once.
- Nothing is written after `destroyed` or `writableEnded`.

The route tests for `/events` must still pass.

## Done when

- The tests pass; `tsc` and eslint pass.

## Done

Branch `fix/sse-05-backpressure` (from sse-04), commit 58f1ada5. New controllers/surface-run/sse.ts (createSseWriter, startSse, SSE_HEADERS, frame); MAX_STREAM_BUFFER_BYTES in config.ts; both stream controllers write only through the writer (frames, heartbeat, end, stream-error). The writer also skips writes once the stream is aborted. Checked in Node that `end()` on a destroyed ServerResponse is a no-op. Tests: tests/controllers/surface-run.sse.test.ts (4); route tests unchanged. jest 63 pass, tsc and eslint clean. Not tested against a real slow socket.
