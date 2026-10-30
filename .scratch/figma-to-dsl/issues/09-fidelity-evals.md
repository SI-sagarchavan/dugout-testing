# 09 · Evals that score fidelity

Status: ready-for-agent
Type: task
Blocked by: 04, harness 01, harness 02, harness 07

## What

The Figma suite on top of the harness eval support (harness 07). The baseline suite (04) runs code only; this one runs the agent:

- **Graders:** fidelity per section (the gate's score and pass), DSL validity, only primitives and tenant tokens used, patches kept inside each task's subtree, and no section recreated where reuse applied (once 07 exists).
- **Report** per run and per kind of section: pass rate, rounds per section, cost per page, time per page.
- **Comparison mode:** run the corpus three ways and compare fidelity, time and cost:
  1. code only;
  2. one agent for the whole page;
  3. one task per failing section.
- **Scripted mode for CI:** recorded model turns, so CI checks the plumbing without paying for a vision model. Live runs nightly or on demand.

## Why

It tells us whether the agent helps, and which kind of section to work on next. It also settles the single-agent versus per-section question with our own pages instead of someone else's benchmark.

## Done when

- `pnpm eval figma-to-dsl` runs the corpus live and writes the report, with the 90% gate set as for other agents or adjusted with a reason.
- The scripted version runs in CI.
- The comparison mode has produced numbers once and they are noted in `spec.md`.

## Pointers

- `packages/evals` (runner, graders, judge, report), `agents/sitemap/evals/suite.ts` (a suite with deterministic graders)
