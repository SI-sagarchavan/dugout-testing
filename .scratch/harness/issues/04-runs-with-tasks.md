# 04 · Runs made of code steps and agent tasks

Status: needs-triage
Type: design + task

## What

Today a run is one agent loop with one transcript. Complex agents need a run that's a small program:

- **Code steps.** Deterministic work, with each step's result saved as an artifact id.
- **Agent tasks inside the run.**
  - Each task has its own transcript and save point, so contexts stay small however big the job.
  - Tasks run up to a limit at a time.
  - Code can end a task: a check passes, the score stops improving, or its budget runs out. The model doesn't decide that it's done.
- **Typed run state.** A run declares its state as a zod schema, with a merge rule per key: replace, append, or merge by id. Code steps and tasks read it and write updates, and the run's checkpoint saves it after every change. This is LangGraph's state schema and reducers. An agent's own notes (memory 04) are the part of it one task writes.
- **One engine; runs written as code first.** The engine is the steps, tasks, typed state, saves after every step (issue 16) and waits for a person. A run is written in TypeScript first: steps, tasks, loops and branches, as Temporal does (step = activity, task = child workflow). A declared graph (nodes, edges, conditional edges), as in LangGraph's Graph API, can run on the same engine later, each node a step or task. It is the way to go if agents are to be put together in a UI by people who don't write code. LangGraph offers both on one runtime.
- **One budget and one lease** for the whole run, held by one worker.
- **Events tagged** with the task they belong to, so a host can show progress per part.
- **Resume after a crash or hand-over.** Finished steps and tasks stay finished, and unfinished tasks resume from their own last save.
- **The host sees one run:** one id, one stream, one review, one result.

Proposed storage: `run_messages` and `run_checkpoints` keyed by run and task, plus a run-level checkpoint recording which steps and tasks are done.

Proposed code shape, with names to be settled: a run definition in code, made of steps and task launches. Its pieces mirror Temporal's: a step is an activity, a task is a child workflow, waiting for a person is a signal. Moving to Temporal later then swaps the engine and leaves agents untouched.

## Why

It's the shape most complex agents take: work split into parts, code and model interleaved, contexts kept small, parts done in parallel. It replaces the `defineWorkflow` that ADR 0007 left unbuilt, and it keeps the rule that one request is one run.

## Done when

- An ADR records the design, its Temporal mapping, and how it extends ADR 0006's single-transcript model.
- A scripted test shows the whole shape:
  - a run with two code steps and three tasks, two at a time;
  - tasks ending on code conditions;
  - a crash mid-run, resumed with finished tasks untouched;
  - events tagged per task.
- The CLI follows such a run and shows progress per task.

## Pointers

- `packages/core/src/loop.ts`, `packages/core/src/local.ts` (`runLocal`, `Steps`), `packages/contracts/src/runtime.ts` (`RunCheckpoint`)
- `apps/worker/src/worker.ts`, `apps/worker/src/run-store.ts`, `packages/db/migrations`
- ADR 0002 (loop over `Steps`), ADR 0006, ADR 0007, ADR 0009
