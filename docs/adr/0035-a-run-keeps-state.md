# 0035 — A run keeps state: what its tools made, saved with the run

Date: 2026-11-10 · Status: accepted · Extends ADR 0006 and ADR 0023

## Context

A run's working memory was its transcript and a checkpoint of counters (ADR 0006). Code had no place of its own to keep what a tool made, so it kept it in three other places:

- **Parsed back from the transcript.** Every agent's check on `final` scanned the messages for an earlier tool's result (`publishedIn`, `builtIn`, `staticIn`, `listedNoteIds`, `listedCommentIds`): a dozen copies of one loop. A result over 16,000 characters is only a reference in the transcript, so the scan found nothing and `final` was refused.
- **A JSON file per run on the worker's disk** (`stateFile` in ui-editor, frame-match and data-bind). A run resumed on another machine does not have it.
- **A map in the process** keyed by run id (the pipeline tool's `done`). A run resumed in another process does not have it either.

Google ADK keeps this in session state that tools write through their context; LangGraph keeps it in the graph's state, saved with each checkpoint. We had the checkpoint and the path (`situation`, ADR 0033, already travels request → tool → outcome → checkpoint) and no general value on it.

## Decision

- **A run has state: JSON values by key** (`RunCheckpoint.state`), saved with every save point. It is absent until a tool keeps something.
- **Tools write it through their context.** `ctx.state.get(key)` and `ctx.state.set(key, value)` (`ToolContext.state`); `undefined` removes a key. A key is declared once with its value's type: `const PUBLISHED = defineState<Published>("ui.published")`.
- **What a call sets is kept only when the call succeeds.** A call that fails, or stops to ask a person, keeps nothing; each retry of a call starts from what the call found. The executor returns the patch on the outcome (`ToolOutcome.state`), the loop applies it and saves, and `tool.completed` carries it. So it works the same when a tool is a Temporal activity.
- **Code reads it; the model never sees it.** The checks on `final` get it (`verifyFinal` and `completeFinal` take `{ ctx, messages, state }`, a hook's `beforeFinal` too), and so do a tool's gates (`resolve`, `block`), read-only.
- **It is for small facts.** One value holds at most 32,000 JSON characters; `set` throws past that. Anything large stays where it is stored and the state holds its reference. It is redacted like a tool result, since it is saved with the run.
- **A fork carries it**, like the transcript it was made beside. So a value that means "done in this run" names the run (`PIPELINE_RESULT` keeps `runId`): a fork may do it again.
- **The transcript is still read for tools that are not the agent's own**: a server's, a child agent, `ask`. One helper pairs calls with results (`answeredCalls` in contracts) in place of each agent's own loop.

## Consequences

- An agent's own tool keeps what `final` needs with `ctx.state.set`, and the check reads `run.state.get`. `publishedIn(messages)` and its kind are gone from ui-editor, section-builder, frame-match and data-bind; hook-maker's four scanners, frame-match's `askedIn` and data-bind's `resultsOf` are filters over `answeredCalls`.
- The pipeline tool's "already completed" gate reads the state, so it holds after a restart.
- `ToolContext.state` is required. A test that calls tools by hand passes `memoryRunState()`, the same one to each call of a run.
- A run saved before this has no state. Resumed, its check on `final` finds nothing published and asks for the publish again.
- Not done here, and the next step (`.scratch/sdk-cleanup/`): the per-run JSON files still hold the tried tree and the refusal counters. Moving them needs large values stored by reference, and a gate that can count its own refusals.
