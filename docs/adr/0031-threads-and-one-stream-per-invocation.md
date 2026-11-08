# 0031. Threads, and one stream per invocation

Date: 2026-11-07 · Status: accepted · Amends ADR 0025 (subagents), ADR 0016 (follow-ups) · Related: ADR 0027, ADR 0028

## Context

A child run (ADR 0025) wrote its events to a stream of its own, `run:<child id>:events`. A host following the run it started saw `tool.started page.build`, then heartbeats for the minutes `frame-match` and `data-bind` worked, then `tool.completed`. To show a child's work, Surface Studio opened a second SSE per child, and learned the child ids only from the run detail, which it fetched once. A child that started after the page opened did not appear until the run ended.

Nothing tied together the runs about one section either. A Handoff queued a `section-builder` run. The comments a person sent queued `ui-editor` runs, chained to each other by `parent_run_id` (ADR 0016) and to nothing else. Each was a separate item.

## Decision

**A thread is the top level.** `threads` (migration 019): a tenant's, with a `subject` (`{ handoffId }`, `{ exportId }`, `{ preview }`). Every run has a `thread_id`. A Handoff starts a thread, and every later run about that section joins it: the comments sent to the agent, a re-bind, a retry. **A host names the thread a run joins.** It is never guessed from the run's input. The `runs_thread` trigger then only fills in what follows from that, whoever inserts the run (the worker's queue, a child's record, the backend):
- a thread named on the insert is kept: the backend names the section's thread for the comments sent on it, and `pnpm agent <id> --thread <id>` names one too;
- a child, a follow-up and a fork are in their parent's thread;
- any other run starts a thread. A Handoff's run starts its section's thread this way.

A host starts a thread on purpose with `thread: 'new'` (the backend, for Studio's `newThread`). A first version also guessed a thread from a run's preview link. That was dropped: two Handoffs published the same tree, and a guess put runs in the wrong thread. Only the one-time backfill of older runs still matches links.

**An invocation is a run a host started**: a thread's runs with no `parent_call_id`. Each is **one stream**. A child run's events are written to its parent's stream with the parent's `runId` and next `seq`, and tagged `child: { runId, agentId, parentRunId, callId }` (migration 018 stores it in `run_events.child`). A grandchild's events come up the same way and keep their own tag. A child still has its own `runs` row and save points. Its ending, now an event in the parent's stream, updates its own row and never ends the stream: `isTerminal` and `endsInvocation` read only untagged events, in the worker, the CLI, the backend and Studio.

How: `RunLog.relay` writes an event as the run's next one, and `ToolContext.relay` hands it to a tool. A child caller (`packages/sdk/src/subagents.ts`) gives the child one sink, which relays each event through the call that started it.

**A thread carries its story, not its transcripts.** Context has three layers, each with its own life:

1. **A run's transcript**: its working memory (ADR 0006), its own and nobody else's. A child run has its own window: its parent hands it what it needs in its input, and gets its answer back as a tool result. Sub-agents keep each window small.
2. **The thread's notes** (`thread_notes`, migration 020). When an invocation ends, it leaves a note: what it did (the agent's `threadNote`, else what its output says), what it made (preview, tree, plan and data artifacts, from its own and its children's outputs), what a person decided when it asked, what it left open (`remaining`, a failure), and the children it ran. The next invocation in the thread starts with the notes in its first message, under `## This thread so far`: where things stand (what exists now, the latest of each; what the last run left open), then what happened, newest first. The newest three notes are shown whole, older ones a line each, and the oldest dropped. All of it stays within `THREAD_BUDGET_TOKENS` (1,500). A comment or a data request finds the section's story already told, at a fixed cost. No model writes the notes: they come from the run's record. Child runs read and write none.
3. **Memory a person approved**: house facts and lessons (ADR 0013), proposed by consolidation from each run's own events (a child's are the child's), and approved before any run reads them.

## Consequences

- A host follows one SSE per invocation and sees everything in it live. Studio's queue lists a thread once. The latest invocation gives it its status and open question, and the Send that started it gives it its name. Opened, it lists the invocations, and a child's activity comes from the invocation's stream (`RunStream.children`).
- The backend's run detail builds the run's steps from its own events and each child's from the events tagged with it. `GET /surface/threads` and `GET /surface/threads/:id` list threads and their invocations.
- `pnpm agent` prints a child's events inline, under a line naming the agent.
- A child's own stream key and `run_events` rows are empty from now on. Runs from before this keep theirs. The backfill puts each chain of runs (a run, its children, follow-ups and forks) in one thread, and a chain on a preview in the thread of the run that published it.
- With Temporal (ADR 0028), a child is a child workflow. Its events still go to the parent's stream, because the stream belongs to the invocation, not to the workflow.
