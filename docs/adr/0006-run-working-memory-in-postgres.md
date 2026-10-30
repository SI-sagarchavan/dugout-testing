# 0006 — A run's working memory is saved in Postgres, so runs outlive their process

Date: 2026-10-29 · Status: accepted; claiming, decisions and recovery moved from the API to workers (ADR 0009)

## Context

A run's working memory is its transcript (system prompt, user messages, assistant turns with tool calls, tool results) plus a little bookkeeping. Until now it lived only in the process running the loop. ADR 0004 recorded the cost: a restart lost runs in flight and their pending approvals, and left them `running` in Postgres. Approvals in the API were in-memory promises.

The run events don't replace it: they are redacted, and some transcript messages (nudges, reviewer requests, skipped-call notes) aren't events.

How others keep it (checked 2026-10-29):

- LangGraph: a checkpointer saves the graph state after every step, keyed by `thread_id`; `InMemorySaver` for tests, `PostgresSaver` the usual production choice, `RedisSaver` an alternative. An interrupt ends the invocation and `Command(resume=...)` continues it from the checkpoint. <https://docs.langchain.com/oss/langgraph/persistence>
- OpenAI Agents SDK: a run paused for approval returns a serializable `RunState`; you approve or reject on it and run again. Sessions keep history in SQLite, Redis, SQLAlchemy or OpenAI's Conversations API. <https://openai.github.io/openai-agents-python/sessions/>
- OpenAI Responses API: `previous_response_id` or a Conversations object keeps the history server-side. <https://developers.openai.com/api/docs/guides/conversation-state>
- Claude Agent SDK / Claude Code: an append-only JSONL transcript per session, resumed by session id; session stores can mirror it to S3, Redis or Postgres. <https://code.claude.com/docs/en/agent-sdk/session-storage>

The common shape: an append-only transcript plus a checkpoint, in a durable store, with "waiting for a person" as an ended invocation that a decision resumes.

## Decision

- **What is saved.** The transcript in `run_messages` (append-only, one row per message) and the latest checkpoint per run in `run_checkpoints` (`RunCheckpoint` in the contracts; ADR 0016 keeps every one in `run_checkpoint_history`): step, spend, retry counters, outstanding change requests, the approval it waits for, and progress through the current turn (which calls were approved, which tools started). Both are written in one transaction, with row-level security by tenant like every other table.
- **When.** After every change: each model turn, each tool result, each approval decision, before a tool starts. Saving goes through `Steps.checkpoint`, so the loop stays free of I/O (ADR 0002) and the same loop runs under Temporal later, where the workflow history could take this role.
- **Approvals end the invocation.** In the API the approver answers `{ pending: true }`. The run is saved as `waiting` before `approval.requested` is emitted, so a decision sent the moment the event is seen finds it, and the invocation ends. `POST /runs/:id/approvals/:callId` claims the run (`waiting` → `running`, checked against the waiting call in the same statement, so two decisions can't both win) and resumes it from the checkpoint with the decision. The CLI's approver still answers in place and needs no store.
- **Crashes.** A run holds a lease (`runs.lease_owner`, `lease_until`), renewed on every save and by a heartbeat. A lease belongs to one invocation, not to the process. Every save is fenced by it: a process that lost the run gets `RunInterrupted` before writing anything and stops quietly. A recovery sweep (on start, then every half lease) claims running runs whose lease ran out, through `claim_expired_runs`, a narrow security-definer function (finding them crosses tenants, which row-level security forbids the app role). Then it resumes them from the checkpoint.
- **Resuming after a crash.** A turn the model took but that wasn't saved is taken again. An approved call is not asked again. A tool that started but has no result runs again if it is a read or declares `retries` (our "safe to repeat" marker). Otherwise the model is told the outcome is unknown and to check first.
- **Events.** A resumed invocation continues `seq` from the newest event in Valkey (tokens included) or Postgres, and emits `run.resumed` (reason `approval` or `recovery`), so SSE clients see one gapless stream across invocations. Tracing opens a trace for a run resumed in another process, in the same Langfuse session.
- **Postgres, not Redis.** We already run Postgres with tenant isolation, the transcript is the record of what the agent did, and runs are long-lived (an approval can wait for days). Valkey stays the live event stream. Redis would only earn a place later as a cache for very hot sessions, with Postgres still the record.

## Consequences

- A restart loses nothing: waiting runs wait in Postgres, and running ones are picked up after their lease (60 seconds by default) runs out. This closes the gap ADR 0004 recorded.
- A run is resumed only by the agent version that saved it; a different `spec.version` refuses it.
- A model turn lost in a crash is paid for twice, and its spend isn't counted. Approved writes that may have run are repeated only when the tool says that is safe.
- Agents pass `store` and `resume` through to `runLocal`; `defineAgent` (ADR 0007) will take that over.
- Not yet: threads that span runs (a follow-up message to a finished run, as LangGraph's `thread_id` or OpenAI's Conversations do), a scratchpad the agent writes itself, compaction of long transcripts, and CLI runs that can be resumed (the CLI has no store).
