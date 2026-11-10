# 10 · Dates are calendar days, and times show in the club's zone

Status: resolved (2026-11-10, after review)
Type: task
Blocked by: none

## What

Any date or time a page shows can come out wrong depending on the machine that renders it.

- **A date with no time is read in the machine's zone.** `formatDate`
  (`packages/dsl/src/binding.ts:192`) normalises only ISO strings with a time; anything else goes
  to `Date.parse`, which reads `"7/22/2026"` as local midnight. On a machine in Asia/Calcutta that
  is `2026-07-21T18:30Z`, drawn in UTC as "21 July". The same card renders a day earlier in India
  than in London, and the server and the browser can disagree. Seen in run `f77d8a76`, but it
  happens to every feed that sends a date-only value (`7/22/2026`, `2026-07-22`, `22-07-2026`,
  `22 Jul 2026`).
- **No rule says which zone a time is shown in.** The zone falls back to the render's
  (`options.timeZone`) or UTC. A club's fans read kick-off in the club's zone. The same instant
  `2026-07-22T13:45Z` was shown as 14:45 (the feed's local `time` field) on our preview and 13:45
  on the club's site.

## Change

1. A date-only value (no time part), in any of the common forms, is a calendar day: parse it into
   its year, month and day yourself and format it without any zone conversion. Ambiguous
   day/month orders (`07/08/2026`) take the order a house fact gives (`locale.date-order`,
   default month-first as the SI feeds send), and the binding check (09) reports a value it could
   not read.
2. An instant (a date with a time, or a number) is shown in the zone the binding names, else the
   tenant's house fact `locale.timezone` (`Europe/London`), else UTC. It is never the machine's.
   The renderer passes the fact in as `options.timeZone`; data-bind reads it in `bind.load` and
   names it in a `date` pipe only when the design needs another zone.
3. data-bind's skill: prefer the instant field (`kickoff`) with a `date` pipe over a pre-formatted
   local `date` or `time` string when the data has both, so the date and the time come from one
   value.

## Done when

- `packages/dsl` tests run `formatDate` under `TZ=Asia/Kolkata`, `TZ=America/Los_Angeles` and
  `TZ=UTC` (separate processes or a stubbed parser) and get the same day for every date-only form
  above, and the same time for an instant with `locale.timezone` set.
- A renderer test: the same tree and data render the same text in two process zones.
- `config/tenants/*/facts.json` for the demo tenants and `sb` carry `locale.timezone`.

## Pointers

- `packages/dsl/src/binding.ts` (`formatDate`, the `date` pipe), `packages/renderer` (where
  `options.timeZone` is set), `agents/data-bind/src/facts.ts` (facts read in `bind.load`)

## Comments

2026-11-09: done in `packages/dsl` (`calendarDay`, `formatDate` takes `dateOrder`; no `Date` object, the purity gate holds), `packages/renderer` (`dateOrder` beside `timeZone`, `localeOf(ctx)`), and data-bind (`bind.load` returns `locale` from `locale.timezone` and `locale.date-order`; the skill says to prefer the instant). `locale.timezone` is a house fact in the database for `sb` and in the demo tenants' files. Tests: `packages/dsl/tests/calendar.test.ts` runs `formatDate` in processes of three zones; `packages/renderer/tests/locale.test.ts`. Not in this repo: Surface Studio and SCRE must pass the tenant's `locale.timezone` as the render's `timeZone` (the renderer takes it; nothing here sets it for a hosted page), and SCRE has its own copy of the DSL to port by hand.

2026-11-09 review, reopened (each confirmed under TZ=UTC, Asia/Kolkata, America/Los_Angeles):
- **A date with a time and no zone still goes to `Date.parse`** (`packages/dsl/src/binding.ts:252-257`): `"2026-07-22 13:45"`, `"7/22/2026 1:45 PM"` read in the machine's zone (14:45 / 09:15 / 21:45 for London). Also `"7/22/26"`, `"Sept 22, 2026"`, `"Wed, 22 Jul 2026"`, `"Wednesday 22 July 2026"` ("21 Jul" in Kolkata). Parse these ourselves: a wall-clock time with no zone is a time in the display zone; a named date is a calendar day. `Date.parse` only for strings with an explicit offset or `Z`.
- **An impossible date becomes another day** (`:207-213, 257`): `"2/30/2026"` → "02 Mar". It is `undefined` (the `default` pipe catches it).
- **Years 0–99** become 19xx in `Date.UTC` (`"0026-07-22"` → 1926): use `setUTCFullYear`.
- **The contract flags date-only values as not dates** (`packages/dsl/src/contract.ts:56, 403`, `ISO_DATE_RE` needs a `T`), and gives an unreadable one the same warning: accept what `formatDate` reads; report what it cannot ("report a value it could not read", step 1).
- **`dateOrder` is dropped in a Text that also shows a clock** (`packages/renderer/src/resolve/clock.ts:103`, `client.tsx:130-141`); `renderToPng` and the renderer CLI take no `dateOrder`.
- Tests: the renderer test never changes the process zone (Done when asks two); the DSL test across zones checks one date-only form; cover every form above in each zone.
- `sb`'s `locale.timezone` is an active fact in the database. That is right: `config/tenants/` is for demo tenants only (CLAUDE.md); the ticket's "facts.json for sb" is wrong.

2026-11-10, review fixed (`packages/dsl/src/binding.ts`, `contract.ts`; renderer `clock.ts`): every date is read by our own parser, never `Date.parse` or the machine's zone. Date-only forms (named months, weekday prefixes, `7/22/26`, `20260722`) are calendar days; a date and time with no zone is a wall time in the display zone; only `Z` or an offset makes an instant; impossible dates are `undefined`; years 0–99 kept. The contract accepts what the `date` pipe reads and reports what it cannot (B4). `dateOrder` reaches clocks, `renderToPng` and `fos-render png --date-order`. New export `readDate(value, { timeZone, dateOrder })`. Tests run under UTC, Asia/Kolkata, America/Los_Angeles; checked again by hand on 2026-11-10 (same output in all three).

**Behaviour change to know:** an ISO time with no offset (`2026-07-22T13:45:00`) is now a wall time in the display zone, not UTC. A feed that sends UTC without the `Z` will show its times shifted by the zone's offset; such a feed should be read with its zone named in the binding.
Still outside this repo: Surface Studio and SCRE must pass the tenant's `locale.timezone` as the render's `timeZone`; SCRE's DSL copy needs the parser ported.
