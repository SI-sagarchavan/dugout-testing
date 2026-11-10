# 07 · A club's feeds, known once

Status: ready-for-human (built with the ticket's own suggested answers to the two open questions; seed not run)
Type: task
Blocked by: 03

## What

SI's cricket feeds are a small, known set (schedule, results, squad, player stats, standings,
scorecard; articles and videos from the CMS), each parameterised by client, series and team, per
gender. Today each run rediscovers them, and `sb`'s connectors point at IPL feeds (series 13469,
squad `3845_all_players_10373.json`), so every Southern Brave design binds stand-in data.

Keep what a club's feeds are as house facts, the way `media.*` facts work: for example
`feed.squad.women` → `https://www.southernbrave.com/cricket/v2/series/squad?team_id=2034&series_id=15399&…`,
`feed.squad.men` → `team_id=2042&series_id=15397`, `feed.schedule`, `feed.standings`. hook-maker
reads them as `need.sources` when the need's list matches (squad, fixtures, standings), before
asking a person.

- A person's `data_source` answer (ticket 02) on three sections proposes the fact, as decisions do
  (ADR 0033); `pnpm agent memory fact --key feed.squad.women …` writes one by hand.
- Facts give the feed only; the output's shape stays the design's (hook output shape is free).

## To decide (triage)

- Fact keys: by data kind (`feed.squad.women`) or by feed name? What about a club in several
  competitions (The Hundred and a women's league)?
- Fix `sb`'s IPL-pointing connectors and hooks in Cast, or leave them and let the facts win?

## Done when

- `config/tenants/sb/facts.json` has Southern Brave's feeds; 
- The `team-squad` and `team-fixtures` eval cases (06) pass without a person giving a URL.

## Pointers

- `packages/memory/src/decisions.ts` (answers → proposed facts), the `media.*` facts in data-bind
  (`agents/data-bind/src/facts.ts`)

## Comments

2026-11-09: done with the defaults the ticket suggested, so the two open questions are answered as follows (change them here if wrong). **Keys** are by data kind and label, `feed.<kind>.<label>`; a club in several competitions puts the competition in the label (`feed.squad.hundred-women`). **sb's IPL connectors** are left alone: the club's facts win, since `bind.load` lists the `feeds` and data-bind passes them as `need.sources`, which hook-maker builds on before it looks at any other hook. the two squad feeds and `club.team` are active facts in the database for tenant `sb` (written with `pnpm agent memory fact --approve`; no file in the repo, since `sb` is a real client); no Southern Brave fixtures, standings or schedule feed is known, and none was invented (`team-fixtures` expects a stand-in or none).  A `data_source` answer on three sections proposes the fact by ADR 0033 only if its question declares a `fact`; `data_source` does not yet (the answer is per section, and the label comes from the person's own line), so a fact is written by `pnpm agent memory fact --key feed.squad.women …`.
