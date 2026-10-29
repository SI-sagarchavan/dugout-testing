# 0002 — The loop runs over a `Steps` interface

Date: 2026-10-29 · Status: accepted

## Context

The plan has a Temporal workflow per run and an activity per model or tool call, which makes the loop itself workflow code. Workflow code can't do I/O or stream, so the plan's `AgentRuntime.run(): AsyncIterable<RunEvent>` can't be the core loop's shape. The first slice also runs in-process from a CLI, with Temporal added later.

## Decision

- `runAgent` (`packages/core/src/loop.ts`) is pure control flow. Every side effect goes through `Steps` (`model`, `tool`, `approval`) or the `RunLog` (events).
- In-process, `createLocalSteps` calls the model client, tool executor and an approver directly. Under Temporal, `model` and `tool` become activities and `approval` a signal wait; the loop does not change.
- The tool pipeline is split the same way: `preflight` (registry, spec allow-list, policy, schema, approval decision) needs no I/O and runs in the loop; the executor (timeout, retries, redaction, compaction) runs inside the `tool` step.
- `AgentRuntime` stays in the contracts only as the adapter for agents whose loop isn't ours (e.g. LangGraph).

## Consequences

- The run log stamps `seq` in process. Under Temporal, retries of a step that streams tokens can emit duplicate `token` events; sequence assignment and de-duplication get settled with the Valkey event log.
- Specs that use memory or sub-agents are rejected by the loader until those exist, rather than silently ignored.
