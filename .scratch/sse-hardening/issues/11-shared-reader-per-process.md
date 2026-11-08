# 11 · One Valkey reader and one read per process

Status: done (2026-11-08)
Type: task (needs a design decision first)
Repo: backend (`../wnm-fanxp-backend-surface-auth`)
Blocked by: 12 (the hub also serves the per-run live stream)

## The problem

Every open stream does its own work:

- **Its own Valkey connection.** `openReader()` in `src/services/surface-run/stream.ts` calls
  `valkey().duplicate()` for each feed and each per-run tail, because `XREAD BLOCK` holds a
  connection. Ten people with three tabs each make 30 Valkey connections per task, each looping
  every 2 s.
- **Its own database reads.** `followFeed` calls `getRun` and `threadOfRun` (and `comments`,
  `sectionsOfRun`) for each state change, once per open connection. Ten tabs on one client means ten
  identical reads of the same run at the same moment (a thundering herd).
- **Its reads hold up its tokens.** The state-changing path awaits those reads inside the read loop,
  so a slow query delays every entry after it on that connection (head-of-line blocking).

None of this matters at today's numbers. It does at a few dozen people per client.

## The usual shape

One reader per process per client feed, sharing entries with every local subscriber in memory:

```
Valkey feed ──XREAD BLOCK──▶ ClientFeedHub (one per client, per process)
                                   │  reads the run once per burst, shapes run.updated once
                         ┌─────────┼─────────┐
                     connection connection connection   (each only writes what it is sent)
```

- The hub starts with the first subscriber for a client and stops after the last.
- Each subscriber has its own cursor for resume. A subscriber that resumes from an older id reads
  its backlog with `XRANGE`, then joins the shared tail.
- The shaped `run.updated` is computed once and given to every subscriber.

## Questions to decide

1. Is the per-person feed (`user:<id>:feed`) part of the same hub, or a second hub keyed by person?
2. Should `run.updated` be computed by the worker when it writes the event (once in total), instead
   of by each backend process (once per process)? That needs the backend's shaping available where
   events are written.
3. Is `/surface/runs/:id/events` still needed live, or only with `?history=1` (the Studio reads it
   that way when the feed is on)? If only history, its `tail` and its Valkey connection go away.
4. What load is this for? Settle a target (people per client, tabs per person) and measure the
   current Valkey connections and DB reads per state change before and after.

Move to `ready-for-agent` once these are answered, split into tickets.

## Decision (2026-11-08, delegated to the agent; industry practice)

Build the shared fan-out hub (one blocking read per Valkey stream per process, in-memory fan-out),
generic and keyed by stream key.

1. One hub class, keyed by stream key: the client feed, the person feed and a run's stream are each an
   instance. No special-casing of the person feed.
2. `run.updated` stays computed in the backend. Per process, dedupe: one in-flight `getRun`/`threadOfRun`
   per run, shared by every subscriber, plus a short (~250 ms) result cache. Not in the worker: it would
   couple the worker to the backend's shaping and still not remove the per-process read.
3. Keep `/surface/runs/:id/events` live (ticket 12 depends on it); it becomes a subscriber of the hub.
4. Target: 50 people per client, 3 tabs each. Record before and after: Valkey connections per task and
   DB reads per state change (a counter or log line is enough).
- Resume: a subscriber with an older `Last-Event-ID` reads its backlog with `XRANGE`, then joins the
  shared tail at the entry after the last one it was sent (no gaps, no duplicates).
- The hub starts on the first subscriber and stops (closing its connection) after the last, with a short
  idle delay. It reads in its own loop, so a slow DB read can no longer hold up entries on a connection:
  refreshes run beside it, ordered per run as in ticket 01.
- Tests: two subscribers share one `XREAD`; a late subscriber gets backlog then live without gaps;
  the last unsubscribe closes the reader; N concurrent state changes make one DB read.

## Comments

Choices the Decision did not cover (industry-standard option taken):

- **A shared read must not be older than what the caller knows.** A plain 250 ms result cache would let a `run.completed` that arrives 100 ms after a `running` read be answered with the `running` snapshot. So each hub dispatch bumps a per-process epoch, and a read (in flight or cached for up to 250 ms) answers a caller only if it began at or after the epoch the caller learned of the change at. Concurrent subscribers of one dispatch share one read; a newer change always reads again. Failures are never cached.
- **Person feed is its own hub per person**, as the Decision says (keyed by stream key). So the connection count is one per client feed + one per person with a tab open + one per followed run, per process, instead of one per tab and per followed run. The old single multi-key `XREAD` of client and person feed is gone, so entries of the two feeds are no longer interleaved in one read (nothing relied on it).
- **Refreshes are no longer awaited inside the entry loop.** `run.event` entries are written at once; `run.updated`/`thread.updated` (and comments, setup) go out in per-series order (`run:<id>`, `comments:<id>`, `setup`), beside the entries. A `run.updated` can therefore come after a later `run.event`; it is a snapshot read after the event that asked for it, so it is never older than that event.
- `sectionsOfRun` and `comments` reads are shared the same way as run and thread; `setup` is not (it depends on the caller's token).
- Idle delay `HUB_IDLE_MS` is 5 s, share window `SHARED_READ_MS` 250 ms (`config.ts`). Hubs are closed by `closeHarnessValkey` on shutdown.
- A hub whose Valkey read fails ends every subscriber with the error (so each stream writes `stream-error` as in 08) and is removed; the next subscriber starts a fresh hub.
- Backlog for a late subscriber is one unbounded `XRANGE` up to the hub's position (at most the feed's ~20,000 entries), as `readBacklog` already does for a run.
- Measuring: `hubStats()` (hubs open/opened, subscribers, entries read/delivered, in `hub.ts`) and `readStats()` (`dbReads`, `sharedReads`, in `reads.ts`); hub open/close lines are logged with the counters (`surface stream: hub opened|closed`).

## Done

- Branch `fix/sse-11-shared-reader-per-process` in `wnm-sse-wt` (from `fix/sse-12-tokens-off-feed-backend`). Two commits: `fix(surface-sse): fragments are not appended to the client feed (sse-hardening 12 follow-up)` (`appendEvent` no longer XADDs `token` / `tool.input.delta` to the client feed; the followFeed filter stays for entries already in Valkey), and `feat(surface-sse): one Valkey reader per stream per process (sse-hardening 11)`.
- New: `src/services/surface-run/hub.ts` (generic `StreamHubs`, keyed by stream key; start on first subscriber, stop after idle delay; XRANGE catch-up then shared tail, no gaps or duplicates), `reads.ts` (`SharedReads`). `stream.ts` now offers `subscribeClientFeed`, `subscribeUserFeed`, `subscribeRun` (replacing `openReader`, `readFeed`, `readTail`); `followFeed` and the per-run `tail` are subscribers. `/surface/runs/:id/events` stays live. Behaviour of 01 (ordered refreshes), 02 (id only on run events), 04/05/10 (untouched `sse.ts`), 08 (stream-error) kept.
- Tests (written first): `tests/services/surface-run.hub.test.ts` (two subscribers share one connection and read; late subscriber gets backlog then live, with entries arriving during the backlog read; last unsubscribe closes the reader after the idle delay; resubscribe within it keeps it; failure ends all and restarts; throwing subscriber isolated; counters), `surface-run.reads.test.ts` (30 concurrent askers make one read; newer change reads again; 250 ms window; no cached failure), `surface-run.feed.test.ts` (10 connections, one `getRun`/`threadOfRun`/`sectionsOfRun` per state change; clients not mixed; a slow read does not hold up entries; ordering), `surface-run.append.test.ts` (commit 1); stream and routes tests moved to the new calls.
- Checked: `npx jest tests/services/surface-run tests/routes/surface-run.routes.test.ts` 89 passed; `npx tsc --noEmit` clean; eslint on `src/services/surface-run` and `src/controllers/surface-run` clean.
- Checked against the real local Valkey (:56379) with a throwaway test (not committed): 4 subscribers of one run made 1 extra Valkey connection (plus the shared client) where there were 4 readers before; a late joiner got `2,3,4` with no gap or duplicate.
- Before/after (by construction, 50 people x 3 tabs on one client): before, 150 feed connections' readers plus one per followed run per tab, and one `getRun`+`threadOfRun` per tab per state change (150); after, 1 client-feed reader + up to 50 person-feed readers per process, 1 per followed run, and 1 `getRun`+`threadOfRun` per state change per process.
- Not verified: Valkey connection counts and DB reads on a deployed task with real load (only counters and the local check above); the effect of several backend processes on one client (each has its own hub by design).
