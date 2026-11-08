# 03 · A run's section

Status: resolved
Type: task
Blocked by: 01

## What

A run knows which section it works on, set by code, so a decision can be about it.

- `ToolContext` gains `situate({ section, name })`: `section` is the structural signature of the tree's root (`subtreeSignature`, `@fanos/dsl`), `name` the frame's name for people. Set from verified tool results, never from model input.
- `frame.load` sets it from the compiled tree; `bind.load` from the published tree.
- The loop keeps it in the run's checkpoint (ADR 0006), so a resumed run still has it, and stamps it on `question.asked` as `situation`.
- A child run started after it is set inherits it (`agent.hookMaker` from data-bind), so hook-maker's `hook_choice` is about the section without hook-maker knowing the frame.
- A question asked while a run has no section: a section question is asked and not learned.

## Done when

- `question.asked` from frame-match, data-bind and hook-maker in a `section-builder` run carries the same `situation.section`; a test resumes a run from its checkpoint and still has it.

## Comments

2026-11-08: `Situation` (`packages/contracts/src/runtime.ts`); `ToolContext.situate` and `.situation`; the executor returns it on the outcome, the loop keeps it in the checkpoint (`RunCheckpoint.situation`) and passes it to every later call; `RunContext.situation` starts a child on its parent's (`subagents.ts` → `runLocal`). The section is the IR root's structural signature at depth 64, as the section library signs it (frame-match `toolchain.sign`, data-bind `loadSigner`), not the compiled tree's: overrides change the tree, not the IR. Tests: `packages/core/tests/ask.test.ts` (stamped, saved, inherited), `packages/sdk/tests/decisions.test.ts` (through a child).
