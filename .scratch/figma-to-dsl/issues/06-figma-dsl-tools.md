# 06 · Tools over the FanOS code

Status: ready-for-agent
Type: task
Blocked by: 01, 05, harness 01, harness 02

## What

Typed tools for the repair task, each a thin wrapper with a zod schema. They read the tenant from the run and resolve ids inside it:

| Tool             | Does                                                                                                                                                                                                                                | Effect                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `figma.node`     | Returns a slice of the Figma IR for a node: its subtree, up to a depth                                                                                                                                                              | read                   |
| `dsl.subtree`    | Returns the task's current DSL subtree, or part of it                                                                                                                                                                               | read                   |
| `dsl.patch`      | Applies FanOS ops (`setProp`, `replaceNode`, `wrapIn`, `insertBefore`, `removeNode`, `moveNode`, `collapseToRepeater`) to node ids **inside the task's own subtree only**, validates the result, and stores it as a new DSL version | write (within the run) |
| `render.section` | Renders the current version and diffs it against the screenshot through the service (05). Returns the score and regions as text, and the render and diff as images (harness 01)                                                     | read                   |
| `tokens.list`    | The tenant's tokens, read live, never copied                                                                                                                                                                                        | read                   |

Code steps (compile, collapse repeats, the gate, merge) call the same FanOS functions directly. They aren't model tools.

`dsl.patch` writes only new DSL versions inside the run, so it needs no approval. Publishing goes through the run's review (harness 06).

## Why

These are the repair agent's hands. Patch operations instead of whole trees keep changes small, checkable and easy to show a reviewer, and the FanOS ops were built for exactly that.

## Done when

- Each tool has a zod input schema, a test against a corpus fixture, and an error the model can act on: a node outside its subtree, an invalid prop, a token not in the palette.
- `dsl.patch` refuses node ids outside the task's subtree, shown in a test.
- No tool takes a tenant id as input.

## Pointers

- `trial/packages/dsl/src/ops.ts`, `validate.ts`, `nodes/`
- `trial/packages/compile`, `trial/packages/surface-canvas/src/ir`
- `packages/core/src/tools.ts` (tool pipeline), `agents/sitemap/src/tools.ts` (an example of typed tools here)
