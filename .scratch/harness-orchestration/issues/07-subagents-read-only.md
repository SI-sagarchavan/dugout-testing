# 07 · Subagents: an agent calls another as a tool (read-only children)

Status: done (2026-11-04), ADR 0025

Reopened 2026-11-04 for `bind`: finding which Cast hook feeds a frame is the open-ended search this
was for. Built as specified below; the one real use is `bind` → `hook-finder`.
Type: design + task
Blocked by: none

## What

A spec lists the agents it may call (`agents: ["hook-finder"]`). Each appears as a typed tool,
`agent.<camelId>`, whose input is that agent's input schema. Calling it starts a child run:

- the same tenant;
- its own transcript and checkpoint, a `runs` row with `parent_run_id`;
- a run id derived from the parent run id and the call id, so a parent resumed mid-call finds the child and carries on;
- a budget of at most what the parent has left, with its cost added to the parent's usage (`ToolOutcome.usage`, optional);
- depth checked against `maxDepth`.

In this slice a child may not list a write tool. It never waits for an approval, and it runs inside
the parent's tool step. The parent's `tool.completed` carries the child's run id. Spec: section G.

## Done when

- Tests written first, with scripted models:
  - the child's answer comes back as the tool result;
  - its cost counts against the parent's budget;
  - a parent crashed mid-child resumes without starting the child again;
  - depth beyond `maxDepth` is refused;
  - a child spec with a write tool fails the load;
  - the child can't see the parent's transcript, and runs under the parent's tenant.
- `assertSupportedSpec` no longer refuses `maxDepth > 0`.
- An ADR "Subagents are tools that start a child run".
- One real use, if you confirm it (spec R7): frame-match hands Cast binding questions to a read-only `hook-finder`, which returns the field behind a number or a repeated row in a few lines instead of the hook definition's thousands of tokens.

## Pointers

- `packages/core/src/loop.ts` (`assertSupportedSpec`), `local.ts`, `packages/sdk/src/agent.ts`, `apps/worker/src/queue.ts` (`parent_run_id`), ADR 0017 (how program tasks run agents)
