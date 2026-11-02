# 01 · Run hooks: one place for per-turn rules

Status: done (2026-11-02, uncommitted on feature/harness-orchestration)
Type: task (refactor first, then the seam)
Blocked by: none

## What

Give the loop's per-turn rules one shape: a `RunHook` with optional pure, synchronous
`beforeModel`, `afterModel`, `afterTool` and `beforeFinal`. Move the existing rules onto it with no
change in behaviour: the turns-left warning, the `final` nudge, the repeated-failure stop, the
refused-copy stop and `verifyFinal`. Then let `defineAgent` take an agent's own `hooks`.

Hook state is one optional checkpoint field, `hooks: Record<string, unknown>`. Harness hooks run
first, then the agent's, in list order. Spec: section A.

## Done when

- Step 1, the move: all existing tests pass unchanged. Not one assertion edited.
- Step 2, the seam, with tests written first:
  - an agent hook's `beforeModel` changes what is sent, and the saved transcript is unchanged;
  - resuming from any save point gives the same request as the run that saved it (each built-in hook, run twice on the same state);
  - a hook throwing fails the run with reason `error` and a message naming the hook.
- An ADR "Run hooks", extending ADR 0002 and 0018.

## Pointers

- `packages/core/src/loop.ts`: the warning (line ~519), nudges (~573–590), `failedCall`/`refused` (~360, ~480), `verifyFinal` (~318)
- `packages/contracts/src/runtime.ts` (`RunCheckpoint`), `packages/contracts/src/spec.ts` (`AgentDefinition`), `packages/sdk/src/agent.ts`

## Done (2026-11-02)

- Step 1: the five rules run as hooks (`packages/core/src/hooks.ts`); no existing test file edited, `pnpm check` green.
- Step 2: `packages/core/tests/hooks.test.ts` (13 tests: view vs saved transcript, append, state in the checkpoint, refuse a final, stop after a tool, a throwing hook named in the error, duplicate ids, order, determinism, one warning, repeated-call stops, legacy carry-over) and `packages/sdk/tests/hooks.test.ts`.
- ADR 0023 "Run hooks". CLAUDE.md names it.
- Not done on purpose: `forceFinal` and the loop's `invalidOutputs`/`blockedFinishes` limits stay in the loop (ADR 0023).
