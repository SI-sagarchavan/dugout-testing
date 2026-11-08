# 02 · Only run events move the resume cursor

Status: done (2026-11-08)
Type: task
Repo: backend and frontend
Blocked by: 01 (same file, `feed.ts`, on the backend)

## The problem

The feed's SSE `id:` is the Valkey entry id (`<ms>-<n>`), and the browser sends the last one it saw
as `Last-Event-ID` when it reconnects. The server then goes on after it.

Backend, `src/services/surface-run/feed.ts`: `refreshRun`, `refreshComments` and the
`setup.updated` write pass the id of the entry that *triggered* them. The throttled `run.updated`
goes out up to 800 ms later, after newer `run.event` entries have already been sent with higher ids.
So the ids on the wire go backwards:

```
id: 1700-0  run.event      (step)        ← timer set with id 1700-0
id: 1750-0  run.event      (token)
id: 1790-0  run.event      (token)
id: 1700-0  run.updated                  ← older id, sent last
```

Frontend, `apps/surface-studio/src/entities/surface/api/feed.ts` line 170: `if (sse.id) after = sse.id`
takes every id as it comes. If the connection drops now, it resumes after `1700-0` and the server
sends the two tokens again. `followRunLive` drops repeats by `seq`, so nothing breaks today, but the
cursor is wrong by design and wastes a replay on every reconnect.

## The fix

Backend, `feed.ts`:

- `run.event` keeps its entry id.
- `run.updated`, `thread.updated`, `comments.updated` and `setup.updated` are sent with no `id:`.
  They are snapshots derived from the log, not log entries. A client that misses one is mended by
  `ready { reconnected: true }`, which invalidates every Surface query (`use-feed-sync.ts`).
- Simplify `refreshRun` and `refreshComments` so they no longer take an id.

Frontend, `api/feed.ts`:

- Advance `after` only for `run.event` frames, and only forward: add `isLaterId(a, b)` that splits
  both on `-` and compares the two parts as numbers (milliseconds first, then the counter). Use
  `BigInt` or compare the parts in turn; the ms part is longer than 2^31.
- Export `isLaterId` for the test.

## Tests

Backend, `tests/services/surface-run.feed.test.ts`:

- Update the existing cases that assert an id on `run.updated`, `thread.updated`,
  `comments.updated` or `setup.updated`: it is now `undefined`.
- Add one: a step event, then a token with a later id, then let the throttled refresh fire. The id
  sequence on writes that have one is strictly increasing.

Frontend, `src/entities/surface/api/__tests__/feed.test.ts`:

- `isLaterId`: `'1700-1' > '1700-0'`, `'1701-0' > '1700-9'`, `'10000000000000-0' > '9999999999999-5'`.
- A connection that sends `run.event` `id: 5-0`, then `run.updated` `id: 3-0`, then drops: the next
  `open` is called with `after: '5-0'`.

## Done when

- Both test suites pass, with the new cases failing on the old code.
- Backend `tsc` and eslint, frontend `pnpm typecheck` and `pnpm lint` pass.

## Done

Branch `fix/sse-02-monotonic-feed-cursor` (from sse-01), commit 5d3711fe. BACKEND half only; the frontend half (`isLaterId`, advancing `after` only on run.event) is handled by another agent.
run.updated, thread.updated, comments.updated, setup.updated now carry no id; refreshRun/refreshComments take no id. Updated the existing id assertion; new test (ids strictly increasing, only on run.event) failed before, passes now. jest 55 pass; tsc clean; eslint on feed.ts clean.

## Done

- Branch `fix/sse-02-monotonic-feed-cursor` (worktree `../wnm-fanxp-frontend-sse`), commit 70e1eb81c, stacked on the previous sse branch (base: `fix/sse-00-wip-base`).
- Checked: isLaterId and cursor tests; `pnpm vitest --run src/entities/surface` 142 passed; typecheck and lint clean. The tests were written with the implementation in the same step, so the red run was not observed. The backend half (ticket 02) is handled by another agent.
