# 04 · A child that finished runs again when it is asked something new

Status: resolved (2026-11-10, after review)
Type: task
Blocked by: none

## What

A writing child is answered from its completed try whenever it is called again in the same parent
run (`packages/sdk/src/subagents.ts:195-199`, `completed.get(mine)`). In run `8758c3d4` this
dropped a person's answer: the second `agent.hookMaker` call carried the Southern Brave feeds and
got back run `e6fc38d5`'s answer, unchanged, in 0 s.

The rule exists so a write is not built twice (ADR 0025). Keep that, but key it on what was asked:

- Same input (canonical JSON of the call's input, without `retry`) → answer from the completed try,
  as today.
- Different input → a new try (`attempt + 1`, its own run id), approved like any try. It counts
  toward `MAX_WRITING_ATTEMPTS` only if it fails.
- A completed try that built nothing (for hook-maker, `hookId: null`) is never a reason to refuse
  a new input.
- When the input is the same, the tool's answer says so in words ("already answered for this same
  need; change the need to ask again"), so the model does not report it as a fresh result. Today
  `block` says this but the `done` path in `call` returns the output silently.

Restarts: the store-backed path (`run.store`, attempts by `attemptId`) must find the try for this
input too; save the input's hash on the child's checkpoint.

## Done when

- Tests in `packages/sdk`: same input twice → one child run; changed input → two child runs, the
  second's output returned; restart mid-way keeps both.
- ADR 0025 gets a short amendment: one thing built per input, not per parent run.

## Pointers

- `packages/sdk/src/subagents.ts` (`completed`, `failures`, `attemptId`, `block`)
- `@dugout/sdk/testing` `drafter` (the test agent)

## Comments

2026-11-09 review, reopened:
- **An unfinished try answers a new input.** `packages/sdk/src/subagents.ts:287` (`if (!over) break;`) takes up a try that never ended whatever input it ran with; `inputHash` is compared only for completed tries. A hook-maker try with need A that timed out, then a call with need B: B runs try 1's run id as a recovery on A's input, and A's output is saved under B's hash. Confirmed with a probe. An unfinished try is resumed only for the same input; another input is a new try.
- **After a restart, a same-input call is approved again and reads as fresh** (`:285-289`, `:568-570`): the in-memory completed set is empty, so `block` lets it through, and the store path answers without `again: true`. Read the completed try from the store before asking for approval, and answer with the "already answered for this same need" wording.
- **Tries saved before the input hash existed answer every input** (`:285`, `asked === undefined` breaks). Treat a completed try with no hash as matching no input.
- **No bound on changed inputs:** each new input is a new approved try and only failures count, so in watch mode a model can build without limit. Cap the tries per call site (failed or completed, say 5) and say so when refused.

2026-11-10, review fixed (`packages/sdk/src/subagents.ts`): an unfinished try is resumed only for its own input, another input is the next try; children save `parentCallId`, so a restarted parent reads their tries from the store and a same-need call is refused before any approval ("already answered for this same need … change the need to ask again", `again: true` for code); a completed try with no input hash matches no input; `MAX_WRITING_TRIES = 5` per parent run and key, any outcome, refused with "a person has to look". ADR 0025 amended. Tests in `packages/sdk/tests/subagents.test.ts`.
