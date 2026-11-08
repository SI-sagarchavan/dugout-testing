# 12 · Tokens off the client-wide feed

Status: done (2026-11-08)
Type: task (a trade-off to decide first)
Repo: backend and frontend
Blocked by: none

## The problem

`appendEvent` (backend `src/services/surface-run/stream.ts`) puts every event of every run on the
client's feed, including `token` and `tool.input.delta`: one feed entry per streamed piece of model
output. Every open Studio tab of the client receives all of them, even for runs nobody is looking
at, and parses each one with Zod (`WireEventSchema.safeParse` in `api/feed.ts`).

Side effects:

- Bandwidth and CPU in every tab grow with the number of runs, not with what is on screen.
- Tokens fill the feed's ~20,000-entry trim window fastest, which shortens how long a dropped
  connection can resume without a gap (see 03).

## Options

A. **Leave as is.** Simple, one connection, and fine at today's numbers.

B. **Follow a run for its fragments.** The feed carries every non-fragment event. A screen that
   shows a run's thread asks for that run's fragments: either a second stream
   (`/surface/runs/:id/events`, already there) or a subscribe message on the feed (needs a way for
   the client to talk back: a query parameter on reconnect, or a small `POST /surface/stream/follow`).
   Costs a second connection or a subscription protocol.

C. **Coalesce tokens on the server.** Keep tokens on the feed but merge each run's tokens into one
   entry every ~100 ms. Fewer entries and parses; still sent to every tab.

The reviewer's lean is B with a second stream, since the endpoint exists and HTTP/2 makes extra
streams cheap. Check that the load balancer in front of the backend speaks HTTP/2 to browsers first:
on HTTP/1.1 a browser allows six connections per host.

Decide, then split into tickets.

## Decision (2026-11-08, delegated to the agent; industry practice)

Option B. High-volume, low-value-per-message data (token deltas) is not broadcast to every
subscriber; a client subscribes to it per resource. The feed keeps state, the per-run stream carries
fragments.

- Backend: `followFeed` stops writing `token` and `tool.input.delta` `run.event`s to the feed (they
  stay in the run's own stream and the record). Every other event stays on the feed unchanged.
- Frontend: a screen that shows a run's thread follows `/surface/runs/:id/events` live (after the
  history read) for the fragments only, ignoring the non-fragment events it already gets from the feed.
  `followRunLive` merges both by `seq`, as it does now.
- Not C: coalescing still sends everything to every tab and adds latency to streamed text.
- Before building: confirm the load balancer serves browsers over HTTP/2 (an ALB HTTPS listener does by
  default; check it is on, and that there is no HTTP/1.1-only proxy in front). On HTTP/1.1 a browser
  allows six connections per host, so an extra stream per open run would compete with the feed.
- Tests: feed omits fragments, keeps the rest; `followRunLive` shows tokens from the per-run stream
  and ends correctly when the run completes via the feed.
- Backend and frontend changes ship together (frontend first behind tolerance for both shapes).

## Comments

- `HEARTBEAT_MS` is 15 s (`src/services/surface-run/config.ts`), well under the ALB's 60 s idle timeout; unchanged.
- `followFeed` filters on read, so `appendEvent` still XADDs fragments to the client feed key. That keeps the Valkey trim window filling with them (the second side effect above) and costs one read-and-drop per fragment per open tab. Skipping the `publish` of fragments in `appendEvent` would fix that; not done, outside the ticket's named scope. The feed's `id` cursor only moves on events written, which is safe: a resume re-reads skipped fragments and drops them again.
- Backend and frontend must ship together; the frontend tolerates both shapes, so it goes first.
- The HTTP/2 check on the load balancer was not done here.

## Done (backend half)

Backend half done; frontend half by another agent. Status stays open until the frontend half lands.

- Branch `fix/sse-12-tokens-off-feed-backend` in `wnm-sse-wt` (from `fix/sse-10-max-connection-age`), commit `fix(surface-sse): fragments stay off the client feed (sse-hardening 12, backend)`.
- `followFeed` no longer writes `token` / `tool.input.delta` `run.event`s; all else unchanged. Tests: feed omits fragments but keeps the rest; per-run stream (`followRunEvents`) still carries them; two existing tests that used `token` as a feed event now use other types.
- Checked: jest surface-run + routes (64 passed), `tsc --noEmit` clean, eslint on `feed.ts` clean (test files are in eslint's ignore list).
- Not checked: HTTP/2 at the load balancer; end-to-end with a real Valkey and the frontend.

## Done

Frontend half done; backend half by another agent.

- Repo: `wnm-fanxp-frontend-sse` (worktree), branch `fix/sse-12-tokens-off-feed-frontend` (from `fix/sse-02-monotonic-feed-cursor`).
- Commit: see `git log` on that branch ("follow a run's fragments on its own stream").
- `followRunLive` takes an optional `openFragments`; after the record is read it follows `/surface/runs/:id/events` for `token` and `tool.input.delta` only, with its own cursor (a state event on the feed may be ahead of a fragment still on its way). Both shapes tolerated: the same fragment from feed and stream shows once. Stream reconnects through `followRunStream` (`retryDelay`/`abortableSleep`); if it gives up or is refused, only live text is lost and the follow goes on from the feed. The stream is closed when the follow ends (feed `run.completed`). Mock mode (no feed) unchanged.
- Tests (written first, saw 3 fail): `src/entities/surface/api/__tests__/feed.test.ts`, 5 new. `pnpm vitest --run src/entities/surface` 147 pass, `pnpm typecheck` clean, `pnpm lint` no errors (existing warnings only).
- Not checked: real backend, HTTP/2 on the load balancer (decision's pre-check), fragments' `seq` lining up with the record in a live run, and one extra connection per open run in a browser.
