# 04 · Baseline: compile, render, diff, no model

Status: ready-for-agent
Type: task
Blocked by: 01, 03

## What

An eval suite that runs only code on every corpus section:

1. compile the Figma IR to DSL
2. collapse repeats to Repeaters
3. render the section
4. diff it against the screenshot
5. apply the fidelity gate

For each section it reports: fidelity score, pass or fail, failing regions and their node ids, time, and DSL validity.

## Why

The sections that fail are the agent's whole job. This measures that before any model money is spent, and it becomes the baseline every later change is compared against.

## Done when

- `pnpm eval figma-to-dsl --baseline` (or an equivalent) runs the corpus with no model and writes a report.
- The report shows the pass rate overall and per kind of section.
- It runs in CI, or there's a written reason why it can't.

## Pointers

- `packages/evals` (suite runner, graders, report)
- FanOS: `packages/compile`, `packages/dsl` (`collapseToRepeater` in `ops.ts`), `packages/renderer` (`harness.ts`), `apps/api/src/modules/fidelity/domain/gate.ts`
