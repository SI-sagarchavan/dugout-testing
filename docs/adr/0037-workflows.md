# 0037 — Workflows: code decides what runs next, a model is called inside a step

Date: 2026-11-11 · Status: accepted · Extends ADR 0007 and ADR 0025 · Replaces the hosting slice of ADR 0017

## Context

There are two shapes of work (LangGraph's "Workflows and agents" page draws the same line):

- **An agent**: its model decides what to do next and which tool to call, in a loop.
- **A workflow**: the path is known, so code decides what runs next, and a model is called inside a step, where there is something to judge. The patterns are prompt chaining with a check between calls, parallel calls, a call that routes, an orchestrator that plans and workers that do, and a generator with an evaluator in a loop.

ADR 0007 left `defineWorkflow` unbuilt. Two things stood in for it. A `pipeline` (ADR 0025) runs child agents in code, but only as a tool of a parent agent, so a model takes two turns to start it and hand over its result (`section-builder`). `defineProgram` and `defineGraph` (ADR 0017) are steps, tasks and typed state, and were never hosted in the worker. Neither had the smallest step a workflow is made of: one model call with a typed answer.

## Decision

- **`defineWorkflow({ id, description, input, output, steps, run })`** (`packages/sdk/src/workflow.ts`). `run(ctx, input)` is ordinary code and returns the output. `ctx.run(step, input, { key })` runs a step or an agent and answers with its output; it throws when the step failed, so code can catch it and go another way. Chaining is one call after another, a gate is an `if`, several at once is `Promise.all` (at most `concurrency` run together), routing is a branch on a step's answer, and a loop is a loop.
- **`defineStep({ id, model, instructions, input, output })`** is one model call with a typed answer: the smallest agent, with no tools. Its answer is checked against `output` (and `verify`), and a refusal goes back to the model. It has its skills, its approved lessons and the date like any agent, and may `ask` a person. A step that needs tools is an agent (`defineAgent`); a workflow runs either.
- **A workflow is a run like any other.** It is an agent whose one tool runs the code (`workflow.run`, on the pipeline machinery of ADR 0025), so each step is a child run with its own transcript, save points and events, in the workflow's stream and against its budget. It is queued, followed, paused for a person, resumed and forked by the same worker and hosts. Its own two turns (start the code, hand over the result) are taken by code, not a model (`driver.ts`): they spend nothing.
- **Resume is by key.** After a pause or a crash the code runs again from the top, and each step that completed answers at once with what it answered before. So the same input must make the same calls with the same keys: a second call to one step needs a `key` (a loop's pass, an item's id), and a call without one is refused with that reason.
- **A person's part.** A step's question stops the workflow and the answers go back to the step that asked. When a step writes, a person approves the workflow once before it starts, and that yes covers its steps' writes (`approval: "none"` starts without asking). The rule that the model asks and code does not is kept: what is open is settled by a step, which may `ask`.
- **A failure ends it.** A workflow's steps are fixed, so when the code throws, the run ends failed with what was said; nothing tries another way unless the code does.

- **One way to write fixed steps.** The `pipeline` option of `defineAgent`, `defineProgram`, `defineGraph` and `runProgram` are deleted. A graph is a notation for the same thing; code with `if`, loops and `Promise.all` says it, and is the one that is hosted.
- **A step is tried again by code.** `ctx.run(step, input, { tries })`: a step that fails is run again, up to `tries` times. A step that writes counts its own tries (three in a run, ADR 0025); one that only reads gets a run of its own for each try.
- **After a corrected input it starts again.** A fork or a follow-up carries its parent's transcript and state; the workflow's code turn sees the corrected input and runs the workflow again, and only this run's own result is its result.

## Consequences

- A fixed-step job is a file of ordinary code and its steps, with no parent model, no instructions that explain how to call one tool, and no `completeFinal` to copy the result.
- `section-builder` is a workflow. `page.build` is still the name of the tool its code runs under, so events and hosts read as before. The two Haiku turns that started the pass and handed over its result are gone. What its parent model did with `cast_budget` is a step, `settleBudget`: one Haiku call that settles it from memory, from the evidence, or by asking a person, and answers with the part names. The question keeps its id and its fact (`cast.budget`), so what the club answered before still answers it.
- What changed in behaviour: a stage that fails is tried again by code, at once, up to three times, where the parent model chose whether to call again. A reviewer can no longer send `page.build` back with a change, since no model reads it; it was not asked for approval before either.
- The live path was not run here: `pnpm agent watch` on a Handoff of one slot, and one whose slots pass Cast's hour, should be run before this is relied on.
- A step is a whole run (context built, save points, events), which is more than a bare model call costs in time. It is what makes a step resumable and visible.
