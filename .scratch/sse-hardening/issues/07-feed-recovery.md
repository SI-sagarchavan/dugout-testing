# 07 · The feed recovers after it fails

Status: done (2026-11-08)
Type: task
Repo: frontend (`../wnm-fanxp-frontend`, `apps/surface-studio`)
Blocked by: 06 (same file)

## The problem

`src/entities/surface/api/feed.ts`, `createFeedHub`:

- On a refusal (a 4xx other than 408 and 429), `run()` sets `failed` and returns, but `abort` stays
  set. `start()` returns early while `abort` is set, so neither a new `subscribe()` nor anything else
  starts the feed again. The Studio stops moving until a reload, and nothing on screen says so
  (no component reads the feed's `connection`).
- While `reconnecting`, it sleeps for the backoff even when the reason it failed has gone: the
  laptop came back online, or the tab became visible again after the browser froze it.

A typical refusal is a 401 after the access token expired and the refresh in `http-transport.ts`
also failed, for example because the laptop was asleep. The next refresh, a minute later when the
network is back, would work.

## The fix

In `createFeedHub`:

1. When `run()` ends on a refusal, set `abort = null` after setting `failed`, so a later `start()`
   can run again.
2. Add a `wake()` (internal):
   - if the state is `failed` and there are listeners, `start()` again;
   - if the state is `reconnecting`, end the current backoff sleep at once. Give each sleep its own
     `AbortController`, linked to the main signal, and abort that one.
3. When the hub starts, and only when `typeof window !== 'undefined'`, listen to `window` `online`
   and `document` `visibilitychange` (when `document.visibilityState === 'visible'`), both calling
   `wake()`. Remove them in `stop()`.
4. Don't wake more often than every 5 s: keep the time of the last wake and skip earlier ones.
   Otherwise a tab switching back and forth sends a burst of requests that will be refused.
5. Add `retry(): void` to the `FeedHub` type: a `wake()` that ignores the 5 s limit, for a future
   "reconnect" button.

Out of scope: showing the feed's state on screen. Note under `## Comments` where a banner would go
(`app/layouts/studio-layout.tsx` mounts `useFeedSync`).

## Tests

In `src/entities/surface/api/__tests__/feed.test.ts` (use jsdom's `window` and `document`, and fake
timers):

- A refused open sets `failed`. Dispatching `online` then opens again; the open now succeeds; the
  state goes to `live`, and listeners get `ready`.
- While `reconnecting` with a 15 s backoff, `visibilitychange` to visible opens again without waiting.
- Two `online` events 1 s apart open once.
- After the last listener unsubscribes and the idle close runs, `online` does nothing, and the
  listeners are removed (spy on `removeEventListener`).

## Done when

- The tests pass; `pnpm typecheck` and `pnpm lint` pass.

## Comments

- A banner for `failed`/`reconnecting` would go in `app/layouts/studio-layout.tsx`, next to where `useFeedSync` is mounted; `hub.connection` and the new `hub.retry()` (for a "Reconnect" button) are what it would read.
- After a refusal the next `ready` is sent with `reconnected: true` (the hub remembers it recovered), so pages refetch what they missed.

## Done

- Branch `fix/sse-07-feed-recovery` (worktree `../wnm-fanxp-frontend-sse`), commit 602bdcc3f, stacked on the previous sse branch (base: `fix/sse-00-wip-base`).
- Checked: 4 new tests in feed.test.ts (failed first, then pass); `pnpm vitest --run src/entities/surface` 138 passed; typecheck and lint clean. Not checked: in a real browser (sleep/wake, tab visibility).
