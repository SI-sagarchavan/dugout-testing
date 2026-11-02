# 02 · The request is a view: old tool results cleared, the transcript kept

Status: ready-for-agent
Type: prototype, then task
Blocked by: 01

## What

A built-in `beforeModel` hook. Once a request passes a share of the model's `contextWindow`
(default 50%), every tool result older than the last N turns becomes a one-line stub naming its
`run.readOutput` ref. A result not yet in the output store is stored first, so the ref always works.
It clears in batches down to a low-water mark, so the cache prefix changes rarely. The checkpoint
keeps `hooks.context.clearedThrough`, and the saved transcript keeps everything. Spec: section B.

## First: a live check (prototype)

On Bedrock (si-main): a Claude turn with signed reasoning, a tool call and a long result. Send the
next turn with that earlier result replaced by a stub, and the reasoning block replayed unchanged.
Record whether it's accepted, for `sonnet` and `haiku`. If it isn't, the hook keeps everything up to
the newest signed reasoning block, or drops old reasoning blocks along with their results. Write the
result into the ADR.

## Done when

- Scripted test, 30 turns of long tool output: the request stays under the threshold, the saved transcript has every result in full, and `run.readOutput` on a cleared ref returns the full text.
- Resuming or forking at turn 20 sends the same request as the original run did at turn 21.
- Cache points still land: at most one cleared batch every N turns, not one per turn (counted in the test).
- An ADR "The request is a view of the transcript".
- Harness issue 05 gets a comment that its "old rounds trimmed" part moved here.

## Pointers

- `packages/core/src/tools.ts` (`createToolExecutor`, `maxInlineChars`), `output-store.ts`, `model/bedrock.ts` (`addCachePoints`)
- ADR 0015 (signed reasoning), ADR 0016 (append-only transcript)
