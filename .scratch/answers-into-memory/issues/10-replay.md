# 10 · The Nov 7 → Nov 8 replay

Status: ready-for-agent
Type: task
Blocked by: 05, 06, 07

## What

The case that started this, kept so it stays fixed.

- A worker test (`@dugout/sdk/testing` and the fake Cast hub, `@dugout/mcp/testing`): run one `section-builder` on a fixture of Frame 1984078918 where a person answers `hook_choice: use_existing`, `card_template: 35:10531`, `badge_meaning: overseas`. Consolidate. Run a second Handoff of the same frame: `bind.load` shows the three decisions, hook-maker's `hook_choice` comes prefilled with `use_existing` (`learned.from: decision`), and nothing asks `card_template` again.
- A `data-bind` eval case with the decisions seeded (`agents/data-bind/evals/` is empty today: this starts its `suite.ts`), graded on: the need names runs and strike rate, no new hook is built, the template is the card with both badges.
- Run it on `haiku` and `opus` (`pnpm eval data-bind --model …`) and note the pass rate on each here.

## Done when

- The test passes; the eval case is in the suite and its result on both models is noted under Comments.

## Comments

2026-11-08: the replay is `packages/sdk/tests/decisions.test.ts`: a builder whose child situates on a section and asks `hook_choice`; the person answers `use_existing` on the run the host follows; the next run on the section is proposed `use_existing` with `learned.from: decision`, and answering it again strengthens the one decision. Not done: the data-bind eval case and its pass rate on haiku and opus. It needs a frame fixture data-bind can load without the control plane, a Cast stand-in with the squad hook, and live model runs; `agents/data-bind/evals/` is still empty.
