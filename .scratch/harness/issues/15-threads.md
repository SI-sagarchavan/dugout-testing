# 15 · Threads: a follow-up run carries on from the last one

Status: ready-for-agent
Type: task
Blocked by: memory 04 (compaction)

## What

Today a run is one request, and a follow-up starts from nothing but long-term memory. Let runs form a thread:

- **The host starts a run in a thread.** `queue.start(tenant, agent, input, { threadId })`. The host owns the thread id, like the tenant, and the model never sets either. A thread belongs to one tenant (row-level security) and one agent.
- **A run in a thread starts from where the previous one ended.** It gets:
  - the previous run's transcript, compacted (memory 04: a summary of older turns plus the last ones);
  - its result;
  - its run state (issue 04), if it has any.

  The new input arrives as the next user message.
- **One run of a thread at a time.** A second one waits in the queue until the first ends.
- **What stays per run:** events, the stream, approvals, cost and consolidation. A thread links runs; it doesn't merge them.
- **The CLI:** `pnpm agent <id> --tenant <t> --after-run <runId> --<input>` continues the thread of that run.

## Why

Follow-ups ("now move Fan Zone under Fixtures", re-sending one Figma section) shouldn't redo or forget the work before them. LangGraph's `thread_id`, OpenAI's Conversations and Claude Agent SDK sessions all carry state across requests this way. ADR 0006 lists threads as not yet built.

## Done when

- A scripted test runs a sitemap, then a follow-up in the same thread asking for one change. The follow-up sees the first result and changes only that part.
- A run in another thread, or another tenant's, sees none of it.
- Two runs sent to one thread at once run one after the other.
- An ADR records how threads extend ADR 0006, and what the host contract (ADR 0009) gains.

## Pointers

- `apps/worker/src/queue.ts`, `apps/worker/src/worker.ts`, `packages/core/src/local.ts` (`resume`), `packages/db/migrations`
- ADR 0006 ("not yet: threads that span runs"), ADR 0009
