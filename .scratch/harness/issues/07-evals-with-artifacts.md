# 07 · Evals with artifacts, images and recorded runs

Status: ready-for-agent
Type: task
Blocked by: 01, 02

## What

The eval runner today grades text and JSON from runs on a scripted or live model. Complex agents need more:

- **Cases with artifacts.** A case's input can reference fixture files (images, exports). They're loaded into the artifact store before the run.
- **Graders over artifacts.** A grader can read a run's output artifacts, and call code that compares them, such as a pixel diff or a validator. Graders stay plain functions.
- **Recorded runs for CI.**
  - Record a live run's model turns once, then replay them.
  - CI then checks the plumbing (tools, steps, tasks, review) without paying for a vision model.
  - Live runs happen nightly or on demand.
- **Per-task metrics:** rounds, cost and time per task and per run, as well as pass rates.
- **Comparison mode.** Run the same cases under several setups (code only, one agent, tasks in parallel) and report them side by side.

## Why

Without it, image agents can't be tested in CI, and design choices like single agent versus tasks get decided by opinion instead of numbers.

## Done when

- A suite with an image fixture and an artifact grader runs locally and in CI, from recorded turns.
- The report shows per-task metrics.
- The comparison mode runs two setups over one suite and prints them side by side.

## Pointers

- `packages/evals` (runner, graders, judge, report), `packages/core/src/model/scripted.ts`
- `agents/sitemap/evals/` (a suite with deterministic graders)
