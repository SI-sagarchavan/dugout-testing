# 05 · Consolidation records decisions and proposes facts

Status: resolved
Type: task
Blocked by: 02, 03, 04

## What

`consolidateRun` (`packages/memory/src/consolidate.ts`) stops calling `recordAnswer`. For each answer a person chose (`source: person`, as now; never `auto`, `agent` or `memory`), on a declared question:

- **Section question, with a section:** `recordDecision`. When `sectionsAnswered` reaches 3 for the same answer and the question names a `fact`, propose that fact (content and value), with the decisions as `sources`.
- **Tenant question:** propose its `fact` with the answer as value, unless the active fact already says the same. A text answer that is one example (a URL with one id in it, as `…/players/4661.png` was) is proposed as given: a person fixes the pattern in `memory review`.
- **Undeclared, or a section question with no section:** nothing beyond the run record.

Each answer is recorded once, under the agent that asked: the first run in the question's `from`, or the run itself when `from` is empty. The parent's consolidation does not record a child's forwarded question again. Redaction as now.

## Done when

- Tests: a section answer becomes a decision under the asking child; the same answer on three sections proposes the fact once; a tenant answer proposes its fact; `auto` answers learn nothing; a forwarded question is recorded once.

## Comments

2026-11-08: `learnAnswer` in `consolidate.ts`; `learnsAnswers: !ctx.parent` from `memoryHooks`, so a child's forwarded question is learned once, in the run a person answered, under `about.agent`. `PROMOTE_SECTIONS = 3`. Tests in `packages/memory/tests/decisions.test.ts`.
