# SDK cleanup: run state, one way to write fixed steps, less plumbing

Status: started 2026-11-10. Slice 1 (run state) is built; the rest are the tickets in `issues/`.

## Why

Writing an agent took more than it should, and a run had no place for what its tools made:

- every agent parsed an earlier tool's result back out of the transcript to check `final` (a dozen copies of one loop), and a result over 16,000 characters is only a reference there;
- ui-editor, frame-match and data-bind each keep a JSON file per run on the worker's disk (`stateFile`), which a run resumed on another machine does not have;
- fixed steps can be written three ways (`pipeline`, ADR 0025; `defineProgram` and `defineGraph`, ADR 0017), and only `pipeline` runs in the worker;
- a workflow has to be an agent: `section-builder` is a model whose job is to call one tool and then `final`;
- `depth`, `parent`, `situation` and `inputHash` are threaded by hand through `RunOptions`, `RunLocalOptions`, `RunContext`, `ToolContext` and `RunCheckpoint`.

Google ADK and LangGraph were the reference: both keep run state that tools write and the checkpoint saves, and both make a fixed sequence a first-class thing with no model in it.

## Built (slice 1, ADR 0035)

- **Run state.** `RunCheckpoint.state`, `ToolContext.state` (`get`/`set`, a key is `defineState<T>(name)`), kept only when a call succeeds, at most 32,000 characters a value, redacted, on the `tool.completed` event, carried by a fork. `verifyFinal`, `completeFinal`, `beforeFinal`, and a tool's `resolve` and `block` read it.
- **Agents moved onto it.** ui-editor (`PUBLISHED`, `LISTED_COMMENTS`), section-builder (the pipeline's `PIPELINE_RESULT`), frame-match (`PUBLISHED`, `LISTED_NOTES`), data-bind (`PUBLISHED`, `STATIC`, `LISTED_NOTES`). Their transcript scanners are deleted.
- **One transcript helper.** `answeredCalls(messages, name)` in contracts, for tools that are not the agent's own. hook-maker's four scanners, frame-match's `askedIn` and data-bind's `resultsOf` use it.
- **The pipeline's "already completed" gate** reads the state (per run id, so a fork may build again) instead of a map in the process.
- **SDK.** `AgentConfig` takes `AgentDefinition`'s fields instead of declaring six of them again; the unused `AgentRuntime` is gone.
- Tests: `packages/core/tests/state.test.ts`, `transcript.test.ts`; each agent's tests of its checks on `final` now build state, not messages.

## Built (slice 2, ADR 0036)

- **The request gets smaller.** Compaction starts at the lower of 65% of the window and 150,000 tokens, sized by what the model counted; the summary is written from the turns as they were; `Tool.latestOnly` takes a tool's superseded results out of the request (`bind.try`, `ui.try`, `frame.override`).
- **Memory that was written is read.** Every run is told the date; an agent's approved lessons are in its instructions; `ui.load` says which section the run is on and returns what people said about it.
- **Less to write for an agent.** A spec needs `id`, `instructions` and `model`; `tools` may be a list; `dir` only with skills. Guide: `docs/agents/writing-an-agent.md`.
- A thread's state lines count against its budget.
- Not run: the live evals. Run `pnpm eval frame-match` and `pnpm eval data --live` before trusting an earlier pass rate.

## Built (slice 3, ADR 0037)

- **Workflows.** `defineWorkflow` (code decides what runs next) and `defineStep` (one model call with a typed answer), hosted as a run like any other on the child-run machinery. Its own turns are code. `section-builder` is one. The `pipeline` option, `defineProgram` and `defineGraph` are deleted: there is one way to write fixed steps.

## Kept as it is, on purpose

- **`spec.tools` beside `tools: () => [...]`.** The spec is the reviewed allow-list, read without building the tools (hosts, the terminal's tool tables, `pnpm agent schemas`), and it chooses among memory's tools too. `defineAgent` already fails when the two disagree.
- **The checkpoint's legacy fields** (`refused`, `failedCall`, `stepsWarned`, `upgradeWaiting`). They only read runs saved before hooks and questions; removing them is a cutoff on stored rows, not an API change.

## Tickets

1. `issues/01-per-run-files-into-state.md`: the tried tree and the refusal counters out of the per-run JSON files.
2. `issues/02-one-way-to-write-fixed-steps.md`: `defineWorkflow`, and `pipeline` against `defineProgram`.
3. `issues/03-lineage-in-one-object.md`: the child-run fields as one value.
4. `issues/04-context-budgets-that-bind.md`: compaction and inline limits that never trigger.
5. `issues/05-memory-read-paths.md`: memory that is written and never read, and read more than once.
6. `issues/06-mcp-observations-survive-a-resume.md`: a hook's last output kept by reference.
