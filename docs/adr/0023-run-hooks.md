# 0023 — Run hooks: one place for the loop's per-turn rules

Date: 2026-11-02 · Status: accepted · Extends ADR 0002 and ADR 0018

## Context

The loop applied its per-turn rules inline: the "2 turns left" warning, the nudge to call `final`, the stop on a copy of a refused call, the stop on a call that keeps failing, and the agent's `verifyFinal`. Each lived in `loop.ts` next to the control flow, with a checkpoint field of its own. The next pieces of work (clearing old tool results from the request, a plan reminder, a plan check before `final`) are rules of the same kind. Written inline they would add more special cases to a 700-line loop.

## Decision

- **A `RunHook` is a plain object with optional functions** (`packages/contracts/src/hooks.ts`), called at four fixed points:
  - `beforeModel(step, maxSteps, hasOutput, messages)`: may `append` messages (added to the transcript and saved) or return a `view` (what is sent instead; the transcript is untouched).
  - `afterModel(turn)`: may return a `nudge`, the user message that goes in when a turn made no tool call and the run goes on.
  - `afterTool(call, stage)`: `stage` is `denied` (refused before it ran), `cleared` (passed the checks) or `ran` (with `ok`). May return `stop`, which ends the run with `invalid_output`.
  - `beforeFinal(value, ctx, messages)`: may `refuse` the `final`; the reason goes back to the model as `Not accepted: <reason>`.
- **Hooks are pure and synchronous.** No I/O, no clock, no randomness. A rule that needs one of those is a tool or a step. This keeps ADR 0002: the loop is control flow, and the same checkpoint and transcript give the same request on a resume or a fork.
- **A hook's memory is its state**, saved in the optional checkpoint field `hooks[id]` after the call that changed it. A hook returns `state` to replace its own; `initial` is what a run starts with. A hook keeps nothing in a variable.
- **Order.** The harness's hooks run first (`stepsLeft`, `nudges`, `repeatedCalls`, `verifyFinal`), then the agent's own from `defineAgent({ hooks })`, in list order. Ids are unique in a run (`SpecError` otherwise).
- **A hook that throws ends the run** with reason `error` and a message that names it: `hook <id> threw in <phase>: <message>`.
- **The limits stay in the loop.** `invalidOutputs` and `blockedFinishes`, the allowance for invalid, refused or missing `final` calls, and the forced `final` on the last step are the loop's own guarantees. Hooks supply the rule and the wording; the loop counts. A `beforeFinal` refusal counts against `invalidOutputs` like a `verifyFinal` refusal did.
- **No change in behaviour.** The five rules moved without an assertion in an existing test changing. The turn warning, the nudge text, the stop messages and the events are the same. `AgentDefinition.verifyFinal` still works: it is called by the built-in `verifyFinal` hook.
- **Saved runs carry over.** `stepsWarned`, `refused` and `failedCall` are read once when a run resumes and moved into `hooks.stepsLeft` and `hooks.repeatedCalls`. The old fields stay in the schema, marked deprecated, so a checkpoint saved before this still loads. `version` stays 1.

## Consequences

- New per-turn rules are a hook, not a change to `loop.ts`. The context view (clearing old tool results) and the plan checks are built on this.
- The forced-`final` check recognises the nudge by its start (`startsWith`), so a hook that adds text after the nudge does not stop the next turn from being forced. A hook that puts text before it would.
- A hook cannot run a model or read a store. If an agent's rule needs one, it is a tool the model calls, or a step.
- `defineHook` casts a hook typed by its own state to the untyped list type; the loop trusts an agent's hook to return the state shape it declared.
