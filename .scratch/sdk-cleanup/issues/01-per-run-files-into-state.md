# 01 — The per-run JSON files into run state

Status: ready-for-agent

ui-editor, frame-match and data-bind each keep `<dir>/<runId>.json` on the worker's disk (`stateFile`, `readState`, `writeState` in each `src/tools.ts`): the last plan or edits tried (with the whole tree), the refusal counter of the publish gate, what was published, the sources chosen (with a sample of the data). A run resumed on another ECS task has none of it: `ui.publish` answers "Nothing to publish" and the model tries again.

What `final` needs is already in run state (ADR 0035). This ticket moves the rest:

- **Large values by reference.** The tried tree and a source's sample are over the 32,000-character limit. Store each (the run's output store, or the control plane as an artifact) and keep its reference in state.
- **A gate that counts.** `block` on `ui.publish`, `frame.publish` and `bind.publish` writes `refusals` when it refuses. A gate reads state and keeps nothing, and a refused call keeps nothing. Either the loop counts advisory refusals per tool (`RunCheckpoint.hooks` already holds `repeatedCalls`) and hands the count to `block`, or a gate may return a patch with its refusal.
- Delete the three `stateFile` copies and the `dir` option once nothing reads them.

Done when a run paused at an approval and resumed in a fresh process, with an empty runs directory, publishes without trying again.
