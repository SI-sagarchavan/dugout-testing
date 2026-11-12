# 0036 — A smaller request, memory read when the section is known, and less to write for an agent

Date: 2026-11-11 · Status: accepted · Extends ADR 0007, ADR 0013, ADR 0034 and ADR 0035

## Context

An audit of what a run reads found three kinds of gap (`.scratch/sdk-cleanup/issues/04`, `05`):

- **The request never got smaller.** Compaction started at 65% of the model's window. Every agent runs on a model with a window of a million tokens, so that was 650,000 tokens, which a run of $1 to $3 never reaches. Meanwhile every turn reads the whole request again, and a plan tried six times left six results in it, five of them about plans that no longer exist. When compaction did run, its summary was written from 300-character previews of the results.
- **Memory was written that nothing read.** No agent reads episodic memory, so no run was told the date. A lesson a person approved as a rule (`lesson.<hash>`, proposed the third time a reviewer says the same) reached no prompt: frame-match, hook-maker and ui-editor read no house facts, and data-bind's `pin` leaves `lesson.` out. ui-editor never said which section it worked on, so what a reviewer said of its edits was kept about no section and found by no run.
- **A new agent took a page of spec** that was the same in every agent: `version`, `owner`, `skills: []`, `onDemandSkills: []`, `memory`, `budget`, `approvals`, and each tool named twice.

## Decision

### The request

- **Compaction starts at a number of tokens too**: the lower of 65% of the window and 150,000 tokens (`COMPACT_AT_TOKENS`; `compaction.maxTokens` sets another). The size is what the model counted for its last request and reply, plus an estimate of what was added since, when that is more than the estimate alone.
- **The summary is written from the turns as they were**, each result up to 4,000 characters, not from the references that replace them.
- **A tool can say its result replaces the earlier ones** (`Tool.latestOnly`: `true`, or a function of the result). When it does, the earlier results of that tool leave the request and are kept by reference, as compaction keeps them; the transcript is untouched, and `context.compacted` says so. A result that changed nothing replaces nothing. On: `bind.try` (a plan that was applied), `ui.try`, and `frame.override` (a change that was kept, whose findings are the frame's as they now stand).

### Memory

- **Every run is told the date**, in the first user message, with its zone: `Today is 2026-11-11 (UTC).` An agent that reads episodic memory gets it inside `<recalled_memory>` as before.
- **An agent's approved lessons are in its instructions.** `lesson.` facts this agent's runs produced go under "Rules reviewers taught you" for an agent that reads `procedural` memory, whether or not it reads house facts and whatever its `pin`. They are how it works, as its skills are.
- **ui-editor reads its section's memory when it loads.** `ui.load` finds the build records of the preview (`buildsOfPreview`), says which section the run is on (`ctx.situate`), and returns what people said about that section before as `lessons`. So a reviewer's words on its edits are kept about the section, and the next run on it, ui-editor's or a builder's, reads them.
- The rule this follows: memory is read at the moment its key is known. The tenant is known at the start (skills, pinned facts, approved lessons, the thread, the date); the section when the load tool has read it (`before`, `built`, `lessons`, `patterns`); a question when it is asked (decision memory). Nothing is read earlier on a guess.
- **A thread's "what exists now" and "left open" count against its 1,500 tokens**, half of it at most, and say how many lines were left out.

### Writing an agent

- **A spec needs `id`, `instructions` and `model`.** The rest defaults: version 1, no tools named, `memory.read: ["procedural"]`, $1 and 30 steps and no child runs, every write approved. `owner` is optional.
- **`tools` may be a list.** Each tool in it is allowed without being named in `spec.tools`. A function still works, for an agent whose tools take what the host passes; its tools are named in the spec, as memory's are.
- **`dir` is needed only by an agent that lists skills.**
- `docs/agents/writing-an-agent.md` is the guide.

## Consequences

- A long run costs less per turn and reads less that is stale. The first compaction of a run rewrites the cached prefix once.
- The live evals (`pnpm eval frame-match`, `pnpm eval data --live`) were not run with these changes: they spend money and Cast's live runs. The three `latestOnly` tools and the date line change what a model reads, so run them before relying on a pass rate measured earlier.
- Workflows are ADR 0037.
- Not done: the recalled-memory path (lessons and examples by input) still runs for no agent; the per-run JSON files; one token estimator.
