# 01 · A run's refreshes go out in order

Status: done (2026-11-08)
Type: task
Repo: backend (`../wnm-fanxp-backend-surface-auth`)
Blocked by: none

## The problem

`src/services/surface-run/feed.ts`, `followFeed`. Two paths read a run again and send it as
`run.updated`:

- the throttled path (lines 111–118): after a non-fragment event, a timer fires 800 ms later and
  calls `void refreshRun(...)`. Nobody waits for it, so it runs alongside the main read loop.
- the state-changing path (lines 101–109): on `run.started`, `question.asked`, `run.completed` and
  so on, it clears a *pending* timer and awaits `refreshRun` at once.

When the timer has already fired and its read is still in flight, clearing the timer does nothing.
The two reads race, and the slower one writes last:

```
t=0     step event          → timer set
t=800   timer fires         → getRun() starts (slow DB: 600 ms) … reads status "running"
t=900   run.completed       → getRun() starts (fast: 50 ms) → writes run.updated {completed}
t=1400  slow read returns   → writes run.updated {running}     ← last write wins on the client
```

`use-feed-sync.ts` replaces the cached run with whatever arrives last. The run is over, so no
further event corrects it: the Studio shows a finished run as running until a reload.

## The fix

Run the refreshes of one run one after another, in the order they were asked for, so the last one
sent is always the last one read.

In `followFeed`:

- Keep `const chains = new Map<string, Promise<void>>()`.
- `queueRefresh(runId, id)`: chain onto `chains.get(runId) ?? Promise.resolve()` with
  `.then(() => refreshRun(runId, id))`, store the new promise, and delete the map entry when it
  settles if it is still the stored one. `refreshRun` already swallows errors through `settle`, so
  the chain never rejects.
- The timer callback calls `void queueRefresh(...)`.
- The state-changing path does `await queueRefresh(...)`, so it waits for any read in flight and
  then reads again.
- In the `finally`, there's nothing to cancel: a chained refresh that runs after the abort already
  skips its write (`if (opts.signal.aborted) return`).

Leave the comments refresh as it is: it is only ever awaited inline.

Don't add a version check on the client here. Ordering on the server is enough for one connection.

## Tests

In `tests/services/surface-run.feed.test.ts`, add a case where a slow read loses the race:

- `source.run` returns a promise you resolve by hand. The first call resolves with
  `{ id: 'r1', status: 'running' }` after the second call has been made; the second call resolves at
  once with `{ id: 'r1', status: 'completed' }`.
- Entries: a non-fragment step event, then (after advancing jest's fake timers past 800 ms so the
  timer read starts) `run.completed`.
- Expect the last `run.updated` written to be `completed`, and `run.updated` written twice in that
  order.

The existing feed tests must still pass unchanged.

## Done when

- The new test fails on the old code and passes on the new.
- `npx jest tests/services/surface-run`, `npx tsc --noEmit` and eslint on the changed files pass.

## Done

Branch `fix/sse-01-ordered-run-refreshes` (worktree /Users/sagarchavan/si/build/wnm-sse-wt), commit 8f4bba5c. Cut from `fix/sse-00-wip-base`, a snapshot of the uncommitted surface-run working tree (feed.ts was untracked), because the tickets edit it.
Added `queueRefresh` chain per run in feed.ts. New test in surface-run.feed.test.ts failed on old code (updates ['completed','running']), passes now. jest surface-run + routes: 54 pass; tsc clean. eslint: tests are ignored by config; feed.ts clean.
