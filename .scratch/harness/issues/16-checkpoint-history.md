# 16 · Checkpoint history: replay or fork a run from any step

Status: resolved
Type: task

## What

The transcript (`run_messages`) is already append-only, but `run_checkpoints` keeps only a run's latest save point. Keep them all, and use them:

- **History.** Every save also appends the checkpoint to `run_checkpoint_history`, keyed by run and version, with the step and what changed (a model turn, a tool result, a decision). Retention comes from config; the latest save point stays as long as the run.
- **Fork.** A new run starts from run R at version N: the transcript up to that point and its checkpoint. It can take one change:
  - the other decision on the approval R waited for;
  - another model;
  - a corrected input.

  The fork records its parent run and version, and both runs go on independently.
- **Replay.** Re-run from version N with a scripted or live model, and compare the two, for debugging and evals (harness 07).
- **The CLI:**
  - `pnpm agent --history <runId> --tenant <t>` lists the versions;
  - `pnpm agent --fork <runId> --from <version> --tenant <t>` forks.
- **Claude's signed reasoning** (harness 03) stays valid: a fork appends after an unchanged prefix of its parent's transcript.

## Why

LangGraph calls this time travel. It lets you look at a bad step in context, try another decision or model without redoing the earlier work, and turn any run into an eval recording.

## Done when

- A scripted test forks a run at its approval with the other decision; both runs complete, and neither changes the other.
- History lists every version with its step and reason, and a fork from version N sends the model the same request R sent at that point.
- The storage cost per checkpoint is measured and recorded in the ADR.

## Outcome

Built as ADR 0016 records: save points with `savedAfter`, `forkRun` and `queue.history` and `queue.fork`, and retention through `prune_run_history`. A fork's usage starts at 0. A corrected input is refused inside a turn. Still open: the CLI flags (`--history`, `--fork`), because another session is changing the CLI; and comparing a run with its fork, which moves to harness 07.

## Pointers

- `apps/worker/src/run-store.ts` (`save`), `packages/contracts/src/runtime.ts` (`RunCheckpoint`), `packages/core/src/local.ts` (`resume`)
- ADR 0006
