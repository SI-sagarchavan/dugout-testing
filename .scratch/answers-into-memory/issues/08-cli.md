# 08 · The CLI

Status: resolved
Type: task
Blocked by: 04, 05

## What

- Remove `pnpm agent memory answers` (`packages/memory/scripts/answers.ts`, `apps/cli/src/commands.ts`).
- `pnpm agent memory review`: a fact proposed from answers shows the question, the answer, how many sections chose it, and lets the person edit content and value before approving (the photo URL turned into `…/players/{id}.png`).
- `pnpm agent memory fact --key <k> [--value <json>]`: a person writes a valued fact directly.
- `pnpm agent memory decisions --tenant <t> [--section <sig>]`: lists decisions; `f` forgets one.
- `pnpm agent --help` and `CLAUDE.md`'s Commands match.

## Done when

- CLI tests cover review with an edited value, `fact --value`, and `decisions` list and forget.

## Comments

2026-11-08: `memory answers` removed; `memory decisions` (`packages/memory/scripts/decisions.ts`, `--section`, `--list`, `f` forgets); `memory review` shows a proposal's answer and `e` edits sentence and answer; `memory fact --value`. `apps/cli` tests updated. No new CLI tests for the scripts' prompts: they are readline scripts like `review.ts`, which had none.
