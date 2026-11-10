# 06 · An eval suite for the data: hook-maker and data-bind

Status: ready-for-human (built; a person confirms each case's expected answer, and the live cases need a first run)
Type: task
Blocked by: 05

## What

Frame-match got good on its eval suite, baseline and gate; data-bind and hook-maker have none.
Add `pnpm eval data [--model <name>] [--only id,id]`, exits non-zero below a gate.

Each case: a published frame (or slot) from the control plane, a tenant, the data it should get,
and the expected answer. Start with:

- `team-squad` (tenant `sb`, Team frame slot `35:10512`): Southern Brave squad, both genders, tabs
  switch them.
- `team-fixtures` (`sb`, slot `the-road-ahead`): Southern Brave fixtures; today none exists →
  expected `stand-in` or `none`, never `bound`.
- `fixtures-strip` (`demo-cricket`): reference plan `apps/api/data/fixtures-strip-plan.json`.
- one articles list, one videos list, one standings table (from Handoffs already in the control
  plane).

Graders, code first (`packages/evals`):

- hook: the expected hook, or one whose output passes the case's JSON Schema (`cast_validate`).
- right entity: the bound data is about the design's team and competition.
- coverage: every required field of the need is bound (`bind.try`'s `bound`, no ref reading
  nothing).
- format: each bound text matches its placeholder's form ("21 JULY", "19:30", "166/5").
- variants: every variant the design draws is drawn by some item.
- ending: `data` is what the case expects (`bound`, `stand-in`, `none`); no failed run.
- cost and steps, reported, not graded.

Cast quota: 25 live runs an hour; cache each case's hook output after its first live run
(fixtures in `evals/data/`), live only with `--live`.

## Done when

- `pnpm eval data` runs the six cases, prints each grader's result and the pass rate, and is in
  CLAUDE.md's Commands.
- A baseline (`evals/data-baseline.json`) of today's result.

## Pointers

- `agents/frame-match/evals/suite.ts`, `packages/evals` (suite runner, gate)
- Run `3acd204c` for the Team frame's two slots

## Comments

2026-11-09: `pnpm eval data` is in (`agents/data-bind/evals/`, graders in `packages/evals/src/data.ts`, tests in `packages/evals/tests/data.test.ts` and `agents/data-bind/tests/eval-extract.test.ts`). All six cases exist, none `confirmed` yet, so none gates: confirm each `expect` in `cases.ts` (the squad's schema, `team-fixtures` ending `stand-in`, the strip's variants). `team-squad` and `team-fixtures` run on the Team frame's preview in the local control plane; the other four have `needs` (a published preview each) and are skipped until `preview` is set. `evals/data-baseline.json` is the graders run over the recorded run `3acd204c` (squad: wrong team, wrong format; fixtures: bound where it must not be): a live baseline of today's code needs `pnpm eval data --live`, which calls Cast and creates dugout_ hooks, so it was not run here. Format is graded only for a short placeholder with a number (dates, times, scores, counts).

2026-11-10: `pnpm eval data --live` not run, for the same reason as ticket 03 (the backend on :4000 and the tunnel on :9991 were down; the cases read their Handoffs from there). The order grader (ticket 15) is in the suite now: `articles-list` expects `newest-first`. Run `pnpm eval data --live` once they are up, then confirm each case's `expect` and write `evals/data-baseline.json`.
