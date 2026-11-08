# 02 · Compaction in the core loop

Status: done
Type: design + task

## What

Nothing in `packages/core` makes a run's messages smaller. When the window fills, the run fails with `model_context_window_exceeded`, a terminal stop (`packages/core/src/loop.ts:85`). Transcripts already reach 353k characters (card) and 179k (card-match).

## Fix

Before each model call, estimate the request's tokens. When they pass about 65% of the model's window (from `config/models.json`):

1. Keep the system prompt, the first user message (memory, thread, input) and the last few turns as they are.
2. Replace older tool results with their stored reference and a line on what they held. They can be read again with `output.read`.
3. If that is not enough, summarise the older turns into one "state so far" message: what was tried, what was found, what is decided, and what is next.
4. Never split a tool call from its result.

Record a `context.compacted` event with tokens before and after, so the stream and evals can see it. A save point after compaction holds the compacted messages.

Decided: the summary in step 3 is written by a cheap model (`haiku` when `config/models.json` has it, else the run's own). Steps 1 and 2 need no model.

Built as a view, not a rewrite: the saved transcript only grows (`RunStore`), so `checkpoint.compacted` records what was elided and summarised (`packages/core/src/compact.ts`), and the model reads the transcript with it applied. A resume or a fork reads the same view. If the summary cannot be written, the run goes on with the references alone.

## Done when

- A scripted run that would pass the window completes, and has a `context.compacted` event.
- A run under 65% is unchanged, byte for byte.
- Resuming from a save point after compaction works.
