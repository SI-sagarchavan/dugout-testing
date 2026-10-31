# 0017 — A run can be a program of steps and tasks

Date: 2026-10-31 · Status: accepted · Extends ADR 0002, ADR 0006 and ADR 0007

## Context

`runAgent` is one transcript and one model loop. ADR 0007 left `defineWorkflow` unbuilt. A complex job is a small program: deterministic code, agent tasks with their own transcripts, loops and branches, and a typed state those parts share. LangGraph expresses that as a graph of nodes and reducers. Temporal expresses it as workflow code, where a step is an activity and a task is a child workflow. The same jobs need both shapes, on one engine (harness issue 04).

## Decision

- **A program is TypeScript.** `defineProgram` takes an id, an initial state, a merge rule per key (`replace`, `append`, or `merge` by id), and a `run` function. Inside it, `step` is deterministic work, `task` is one agent run, and `all` runs tasks with a concurrency limit. Loops and branches are ordinary code. A step or task id is its resume key, so a loop gives each pass its own id.
- **Code ends a task.** `until` says the task is done. While it returns false the task runs again, up to `maxAttempts`. The model does not decide that the task is finished. When the attempts run out the task is `stopped` and the program continues.
- **A graph compiles to a program.** `defineGraph` takes nodes (`step`, `task`, or `map`) and edges. An edge may have a `when`. The first matching edge wins, and an edge to `END` finishes the walk. A back edge is a loop. `map` fans one node out over a list, under a concurrency limit. `maxVisits` stops a walk that never settles. A task node may set `apply`. After the task returns, the graph runs a step `${visitId}:apply` that folds the output into state, and the next edge sees that state. A resume skips the fold once it has run.
- **One checkpoint for the program.** After every finished step, and after every task attempt that returned, the runner saves `{ version, state, done, attempts }`. `runProgram(..., { resume })` runs the body again and skips ids already in `done`, state included, so a crash continues with finished work untouched. Unfinished tasks run again. The body has to call steps and tasks in the same order with the same ids.
- **Task events carry the task id** (`ProgramEvent.taskId`). The single-agent loop is unchanged: `runAgent` still owns one transcript. A program does not yet run inside the worker, and its checkpoint is not yet a row in `run_checkpoints`. That hosting is the next slice. Under Temporal later, `step` and `task` become activities and child workflows, and `save` becomes the workflow's own history. Agents stay `defineAgent`.

## Consequences

- Authors import `defineProgram`, `defineGraph` and `runProgram` from `@dugout/sdk`. A task is run by a `TaskRunner` the host supplies. Tests pass a scripted one. The worker will pass `runAgent`.
- A task's own transcript, approval and lease stay inside that agent run. The program checkpoint only records the task's output and whether code ended it.
- Parallel tasks apply their patches as each one finishes, by the key's rule. Two `replace`s on one key: the later finish wins. `append` and `merge` keep both.
- Issue 06 (one review for the whole run) and the CLI showing progress per task wait on the worker hosting this checkpoint.
