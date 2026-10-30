# 0016 — Every save point is kept, and a run can be forked from any of them

Date: 2026-10-30 · Status: accepted · Extends ADR 0006 and the host contract of ADR 0009

## Context

`run_messages` was append-only already, but `run_checkpoints` kept only a run's latest save point. A bad step could only be read from the events, and trying another decision or model meant running the whole run again. LangGraph keeps every checkpoint and lets a run carry on from any of them ("time travel").

## Decision

- **Every save is a save point.** A save writes the latest checkpoint to `run_checkpoints` as before, with a `version` that counts up from 1. It also writes a copy to `run_checkpoint_history`, keyed by run and version. The transcript isn't copied: it only grows, so a save point's transcript is the first `checkpoint.messages` of it. `RunStore.load(ctx, version)` loads one, and `RunStore.history(ctx)` lists them, in both stores.
- **A save point says what it came after.** `RunCheckpoint.savedAfter` is one of:
  - `start`, `model`, `call` (a call about to run), `tool` (a result, or why a call didn't run);
  - `waiting`, `decision`, `end`;
  - `fork` (a fork's first save point).

  The loop sets it at each save. Checkpoints saved before this have none.
- **A fork is a new run from a save point.** `forkRun(saved, from, change)` in core and `queue.fork(tenant, runId, version, change)` in the worker. The new run gets:
  - the parent's transcript up to that point, unchanged, so reasoning a Claude model signed against it stays valid (ADR 0015);
  - the parent's events up to the save point's `lastSeq`;
  - the checkpoint, with `savedAfter: "fork"` and `forkedFrom`, and its usage set to 0: the parent paid for the steps before.

  It can take one change:
  - **The decision on the approval the save point waits for,** perhaps the other one. The fork is queued with it. Without a decision, a fork at an approval waits for one.
  - **A corrected input,** appended as a user message, and only between turns: inside one, a message between a tool call and its result would break the turn.
  - **Another model,** in `runs.model`, which the worker passes to the run (`RunOptions.model`).

  The fork records `parent_run_id` and `parent_version`. The first invocation of a fork emits `run.resumed` with reason `fork` and `forkedFrom`. After that, the two runs go on apart.
- **Replay is a fork.** Re-running from a save point with a scripted or a live model is a fork with no change, or onto another model: the fork sends the model the same request its parent sent at that point, which a test checks. Comparing the two runs is left to harness 07, where it serves evals.
- **Retention.** The worker calls `prune_run_history` on start and then hourly. That security-definer function deletes save points older than `RUN_HISTORY_DAYS` (30), except each run's latest, which stays as long as the run.

## Storage

Measured on 2026-10-30 with the scripted match-preview run (three tool calls, one approval, then `final`). It keeps 16 save points. A checkpoint is about 0.4 KB as JSON and 0.5–0.9 KB as stored jsonb (`pg_column_size`, about 0.74 KB on average), so a run's history is about 12 KB. That is about twice its transcript (5.4 KB of JSON). History grows with turns and calls, not with the size of tool outputs, which stay in the transcript.

## Consequences

- **Hosts can show a run step by step and fork it.** `queue.history` and `queue.fork` are the reference (ADR 0009).
- **The CLI has no `--history` or `--fork` yet.** Another session is changing the CLI, so its flags come once that work has landed.
- **Not yet:** comparing a run with its fork (harness 07).
