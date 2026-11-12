# 02 — One way to write fixed steps: `defineWorkflow`

Status: resolved

Fixed steps can be written three ways and one runs:

- `pipeline` on `defineAgent` (ADR 0025, `packages/sdk/src/subagents.ts`): runs in the worker, with child runs, approvals, pauses and retries. It needs a parent model: `section-builder` is Haiku calling `page.build`, then `final`, with instructions that explain how to call one tool.
- `defineProgram` and `defineGraph` (ADR 0017, `packages/core/src/program.ts`): steps, tasks, typed state with merge rules, resume by step id. Used only by their own test; the worker does not host them.

Wanted: `defineWorkflow({ id, input, output, run(ctx, input) })`, where `ctx.run(agent, input, { key })` starts a child run and `ctx.map` fans out under a concurrency limit, and no model is called unless a step needs one.

To decide before building:

1. **Which engine.** The child-run machinery under `pipeline` already has approvals, pauses for a person, retries and the event stream. `defineProgram` has resume by step id and typed state but none of those. Proposal: `defineWorkflow` on the child-run machinery, the run's state (ADR 0035) for what steps share, and ADR 0017 superseded.
2. **Who asks.** The rule is that tools report and the model asks. `page.build` reports `cast_budget` as open and the parent model settles it from memory, the evidence or `ask`. A workflow with no model needs `ctx.settle(open)` (a small model step, only when something is open) or code that asks a person directly. Proposal: `ctx.settle`.
3. **What a workflow run is to the worker**: a run with a transcript of zero model turns, or a kind of its own.

Blocked on the answers to 1 and 2.

## Comments

2026-11-11: not built in slice 2, on purpose. `pipeline` is the one way fixed steps run today. A model-free `defineWorkflow` would save `section-builder` two Haiku turns a Handoff and nothing else, and its model is what settles `cast_budget`. Recommendation: keep `pipeline`, and retire `defineProgram`/`defineGraph` (ADR 0017) unless a job needs resume by step id. Build `defineWorkflow` when a second fixed-step job arrives, as `pipeline` with turns code can take without the model.

2026-11-11, later (ADR 0037): the earlier comment read "workflow" as "no model at all". It means LangGraph's: fixed code paths with model calls inside the steps. Built on that reading: `defineWorkflow` and `defineStep` in `packages/sdk/src/workflow.ts`, on the child-run machinery (answer 1 as proposed), with the workflow's own turns taken by code. What is open is settled by a step, which may `ask` (answer 2, without a new `ctx.settle`). Tests: `packages/sdk/tests/workflow.test.ts`, one for each pattern.

Left for a person to decide:
- Move `section-builder` to `defineWorkflow`: its `page.build` body becomes `run`, and a settle step takes the parent model's place for `cast_budget`. Saves two Haiku turns a Handoff; its fan-out tests script the parent's turns and need rewriting.
- Delete `defineProgram` and `defineGraph` (ADR 0017), or compile `defineGraph` onto `defineWorkflow`.

2026-11-11, last: both decided by the user ("keep what is recommended and delete everything else; if anything old is using it, rewrite it"). Done: `section-builder` is a `defineWorkflow` with a `settleBudget` step; the `pipeline` option, `defineProgram`, `defineGraph` and `runProgram` are deleted; the SDK's pipeline tests are ported to workflows. `pnpm check` passes. Not run: the live Handoff path.
