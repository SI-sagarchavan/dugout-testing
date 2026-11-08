# 04 · Close open streams on shutdown

Status: done (2026-11-08)
Type: task
Repo: backend (`../wnm-fanxp-backend-surface-auth`)
Blocked by: none

## The problem

On SIGTERM, `src/utils/processHandlers.ts` calls `closeApp()`, which waits for in-flight requests,
and exits with code 1 after 25 s if that hasn't finished. ECS sends SIGKILL at 30 s.

An SSE response is taken over with `reply.hijack()` (`startSse` in
`src/controllers/surface-run/index.ts`) and stays open as long as the browser does. The feed never
ends of its own accord. So while any Studio tab is open, `fastify.close()` waits on those sockets:
every deploy hits the 25 s hard exit, the final telemetry flush is skipped, and every client drops
at the same moment.

This is likely rather than seen: no one has watched a deploy with a tab open. Check it as part of
the ticket (below).

## The fix

1. New module `src/services/surface-run/connections.ts`:
   - `const open = new Set<AbortController>()`
   - `trackStream(abort: AbortController): () => void` adds it and returns a function that removes it.
   - `closeAllStreams(): number` aborts each, clears the set and returns how many there were.
2. In `streamEventsController` and `streamFeedController`: call `trackStream(abort)` right after
   creating the `AbortController`, and call the returned untrack in the `finally`.
   - Aborting already ends both loops and reaches `finally`, which ends the response. The `catch`
     already writes nothing when `abort.signal.aborted`. The client sees a clean end without `end`,
     and both client readers reconnect after their last id, to another task.
3. In `src/hooks/index.ts`, next to the existing `onClose` that calls `closeHarnessValkey()`, add a
   Fastify `preClose` hook that calls `closeAllStreams()` and logs the count at info. `preClose` runs
   before Fastify waits for in-flight requests, which is when it is needed; `onClose` is too late.

## Tests

- `tests/services/surface-run.connections.test.ts`: tracked controllers are aborted by
  `closeAllStreams()`; an untracked one is not; the count is right; calling it twice is safe.
- In `tests/routes/surface-run.routes.test.ts`, if the existing setup can hold a stream open (look
  at how the `/events` cases mock `followRunEvents`): open `/surface/stream` with a feed that never
  ends, call `app.close()`, and assert it resolves within a second and the response ended. If
  `inject` cannot hold a hijacked response open, say so under `## Done` and rely on the manual check.

## Manual check

Run the backend locally, then `curl -N -H 'Authorization: Bearer …' -H 'client: …'
http://localhost:<port>/surface/stream`, then send SIGTERM to the server process. The server should
exit within a couple of seconds with code 0, and curl should end. Record what you saw.

## Done when

- The tests pass; `tsc` and eslint pass.
- The manual check, or the reason it could not be run, is recorded under `## Done`.

## Done

Branch `fix/sse-04-close-streams-on-shutdown` (from sse-02), commit 8ade70b3. New services/surface-run/connections.ts (trackStream, closeAllStreams); both stream controllers track/untrack; `preClose` hook in src/hooks/index.ts logs the count.
Tests: connections.test.ts (3) and a route test that holds `/surface/stream` open with a never-ending feed via `inject`, calls `app.close()` and asserts it resolves < 1 s with the response ended (without the fix that test hangs). The route test registers the same preClose hook inline; the real hooks/index.ts is not loaded by route tests, so that exact line is unexercised. jest 59 pass, tsc clean, eslint clean.
Manual check NOT run: the backend needs its full environment (Aurora/knex, auth, .env; only .env.example exists here), so I did not start it with curl + SIGTERM.
