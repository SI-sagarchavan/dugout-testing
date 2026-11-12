# SSE hardening: the Studio's live streams

Status: done; merged into both base branches 2026-11-10 (backend `merge/surface-all` 578c3e2b, frontend `feat/surface-merge-all` fb9753002). Not pushed. Still open: one run in a browser, and HTTP/2 at the load balancer
Opened: 2026-11-08, from a review of the SSE endpoints and the Studio's event binding

## What this is

Surface Studio follows runs live over Server-Sent Events. The design is sound (a Valkey Streams
log, `id:` frames with `Last-Event-ID` resume, heartbeats, a `fetch`-based client, one multiplexed
feed, pushed objects written into the TanStack Query cache). These tickets fix the places where it
can show a wrong state, miss events, or misbehave under load or during a deploy.

The work is in two repos, not in dugout. These tickets live here because this is the project's
tracker.

| Repo | Path | Base branch | Test, lint, types |
| ---- | ---- | ----------- | ----------------- |
| backend | `../wnm-fanxp-backend` (the main working tree since 2026-11-10; it was the `wnm-fanxp-backend-surface-auth` worktree) | `merge/surface-all` | `npx jest tests/services/surface-run tests/routes/surface-run.routes.test.ts`, `npx tsc --noEmit`, `npx eslint <files>` |
| frontend | `../wnm-fanxp-frontend` | `feat/surface-merge-all` | from `apps/surface-studio`: `pnpm vitest --run src/entities/surface`, `pnpm typecheck`, `pnpm lint` |

Paths in the tickets are relative to the repo they name.

## The pieces (read before any ticket)

Backend (Fastify 5, ioredis against dugout's Valkey):

- `src/routes/surface-run/index.ts`: `GET /surface/stream` (the feed) and `GET /surface/runs/:id/events` (one run).
- `src/controllers/surface-run/index.ts`: `startSse` (takes over the response with `reply.hijack()`), `streamEventsController`, `streamFeedController`, the heartbeat interval.
- `src/services/surface-run/feed.ts`: `followFeed`. It reads the client's feed and the person's feed from Valkey, writes `run.event` for each entry and, after state changes, reads the run again and writes `run.updated` and `thread.updated` (`refreshRun`), or `comments.updated` and `setup.updated`.
- `src/services/surface-run/stream.ts`: Valkey keys, `XADD`, `XREAD BLOCK`, `openReader()` (one duplicated connection per open stream).
- `src/services/surface-run/index.ts`: `followRunEvents` and `tail` for the per-run stream.
- `src/services/surface-run/config.ts`: `HEARTBEAT_MS`, `BLOCK_MS`, `RETAIN_SECONDS`.
- `src/utils/processHandlers.ts`: SIGTERM, then `closeApp()`, with a 25 s hard exit.
- Tests: `tests/services/surface-run.feed.test.ts`, `tests/services/surface-run.stream.test.ts`, `tests/routes/surface-run.routes.test.ts`.

Frontend (`apps/surface-studio`):

- `src/entities/surface/api/sse.ts`: the SSE frame parser.
- `src/entities/surface/api/feed.ts`: `createFeedHub`, the one connection, reconnects, the stall watchdog.
- `src/entities/surface/api/follow-run.ts`: `followRunStream`, the per-run stream (used without a feed, in mock mode).
- `src/entities/surface/api/follow-run-live.ts`: `followRunLive`, which reads a run's record once and then follows it on the feed.
- `src/entities/surface/api/http-transport.ts`: opens both streams through axios with the `fetch` adapter.
- `src/entities/surface/queries/use-feed-sync.ts`: writes feed messages into the query cache.
- `src/entities/surface/queries/use-run-stream.ts`: folds a run's events into its thread, once per animation frame.
- Tests: `src/entities/surface/api/__tests__/feed.test.ts` (covers `followRunLive` too), `follow-run.test.ts`, `sse.test.ts`, `queries/__tests__/use-feed-sync.test.ts`.

## Tickets

| # | Ticket | Repo | Blocked by |
| - | ------ | ---- | ---------- |
| 01 | [A run's refreshes go out in order](issues/01-ordered-run-refreshes.md) | backend | none |
| 02 | [Only run events move the resume cursor](issues/02-monotonic-feed-cursor.md) | backend + frontend | 01 |
| 03 | [A followed run reads its record again after a reconnect](issues/03-follow-run-live-gap-recovery.md) | frontend | none |
| 04 | [Close open streams on shutdown](issues/04-close-streams-on-shutdown.md) | backend | none |
| 05 | [Drop a client that cannot keep up](issues/05-backpressure.md) | backend | 04 |
| 06 | [Exponential backoff with jitter](issues/06-jittered-backoff.md) | frontend | none |
| 07 | [The feed recovers after it fails](issues/07-feed-recovery.md) | frontend | 06 |
| 08 | [Backend stream hygiene](issues/08-backend-stream-hygiene.md) | backend | 05 |
| 09 | [Frontend stream hygiene](issues/09-frontend-stream-hygiene.md) | frontend | 03, 06 |
| 10 | [A maximum age for each connection](issues/10-max-connection-age.md) | backend | 05 |
| 11 | [One Valkey reader and one read per process](issues/11-shared-reader-per-process.md) | backend | 12 |
| 12 | [Tokens off the client-wide feed](issues/12-tokens-off-the-feed.md) | backend + frontend | none |

Do 01–05 first. 06, 07 and 10 next. 08 and 09 whenever. 11 and 12 are decided (see each ticket's `## Decision`); do 12 before 11.

## How an agent works a ticket

1. Set `Status: claimed` in the ticket and save.
2. In the ticket's repo, branch from the base branch above: `fix/sse-<NN>-<slug>`.
3. Change only what the ticket names. Anything else you notice goes under `## Comments` in the
   ticket, not in the diff.
4. Write the tests the ticket asks for first and watch them fail, then make them pass. Run the
   repo's test, lint and type commands above; all must pass.
5. Commit with a message that names the ticket (`fix(surface-sse): … (sse-hardening 01)`). Don't
   push or open a PR unless the person asks.
6. Append `## Done` to the ticket: the branch, the commit, what you checked and how, and anything you
   could not check. Set `Status: done (<date>)`.
