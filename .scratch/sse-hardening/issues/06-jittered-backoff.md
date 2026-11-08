# 06 · Exponential backoff with jitter

Status: done (2026-11-08)
Type: task
Repo: frontend (`../wnm-fanxp-frontend`, `apps/surface-studio`)
Blocked by: none

## The problem

Both stream readers wait `base × failures` between reconnects, capped:

- `src/entities/surface/api/feed.ts` line ~199: 1 s, 2 s, 3 s … up to 15 s.
- `src/entities/surface/api/follow-run.ts` line ~155: 1 s, 2 s, 3 s … up to 10 s.
- `src/entities/surface/api/follow-run-live.ts` line ~103: `HISTORY_RETRY_MS * attempt`.

The delays are the same for every client. When a backend task goes away (a deploy, a crash), every
open tab reconnects at exactly +1 s, then the ones that failed at +2 s, and so on: synchronised
waves against the tasks that are left (a reconnection storm).

## The fix

New `src/entities/surface/api/backoff.ts`:

```ts
/** "Full jitter": a random wait up to the exponential ceiling, never below `floorMs`. */
export function retryDelay(
  failures: number,
  { baseMs, maxMs, floorMs = 250, random = Math.random }: {
    baseMs: number; maxMs: number; floorMs?: number; random?: () => number;
  },
): number
```

Ceiling `min(maxMs, baseMs × 2^(failures − 1))`, result `max(floorMs, floor(random() × ceiling))`.

Also move the `sleep(ms, signal)` that resolves early on abort (copied today in `feed.ts` and
`follow-run.ts`) into `backoff.ts` as `abortableSleep`, and use it from both.

Use `retryDelay` in `feed.ts` and `follow-run.ts`, with the bases and caps they have now. Add an
optional `random` to `FeedHubOptions` and `FollowRunOptions` (test hook, like `sleep`).
`follow-run-live.ts`'s history retry is ticket 09; leave it.

## Tests

- `src/entities/surface/api/__tests__/backoff.test.ts`: with `random = () => 1` the delays for
  failures 1…6 at base 1000, max 15000 are 1000, 2000, 4000, 8000, 15000, 15000; with
  `random = () => 0` every delay is the floor; the result never goes above `maxMs`.
- Existing tests in `feed.test.ts` and `follow-run.test.ts` that check the delays passed to `sleep`:
  give them `random: () => 1` and update the expected values.

## Done when

- The tests pass; `pnpm typecheck` and `pnpm lint` pass.

## Done

- Branch `fix/sse-06-jittered-backoff` (worktree `../wnm-fanxp-frontend-sse`), commit a73f0d7f9, stacked on the previous sse branch (base: `fix/sse-00-wip-base`).
- Checked: new backoff tests plus delay cases in feed and follow-run tests; `pnpm vitest --run src/entities/surface` 134 passed; typecheck and lint clean. `follow-run-live` history retry left for 09.
