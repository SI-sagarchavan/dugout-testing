# 09 · Move sb's answers, drop answer_memory

Status: ready-for-human
Type: task
Blocked by: 05, 06, 08

## What

`answer_memory` holds 19 rows, all `sb`, none standing (2026-11-08). They name no section, so most cannot become decisions.

- A one-off script (`packages/memory/scripts/move-answers.ts`), dry run first, printing what it does:
  - "Which domain should go in front of … paths" (twice, `https://www.southernbrave.com`) → proposed fact `media.image-domain`.
  - The two player-photo URLs → one proposed fact `media.player-photo`, value left for a person to make a pattern.
  - Carousel `loop: true` (8 times) → proposed fact `layout.carousel.loop`.
  - The rest (one frame's items/autoplay, build-or-use, card shape, badge, toggle, a Cast reconnect confirm) → dropped, listed in the output.
- Migration `023_drop_answer_memory.sql`.
- Delete `packages/memory/src/answers.ts`, `tests/answers.test.ts`, its store wiring and exports; migration 014 stays as history.
- Unpublish or delete Cast's `dugout_cricket_player_cards_full` on `sb` (the Nov 8 hook that dropped the stats) once a person agrees: it is in a shared workspace.

## Done when

- Dry run reviewed by a person, then run on `sb`; `answer_memory` is gone; `git grep answer_memory` finds only migrations 014 and 023 and the ADRs; `pnpm check` passes.

## Comments

2026-11-08: done as a migration, not a script: `023_answers_into_memory.sql` moves the three kinds of club answer into proposed facts and drops the table, so every database gets the same move in order. `answers.ts`, its test, `scripts/answers.ts` and the store wiring are deleted. Dry run on the dev `harness` database (read only): `sb` → `media.image-domain` = `https://www.southernbrave.com`, `media.player-photo` = `https://www.southernbrave.com/static-assets/images/players/4661.png?v=1.16&w=285` (to make a pattern in review), `layout.carousel.loop` = true; the other 16 rows dropped. Left for a person: run `pnpm db migrate` on the dev database (applies 022 and 023), and decide on Cast's `dugout_cricket_player_cards_full` on `sb`.
