# Harness work for complex agents

Status: planning, 2026-10-30. Nothing here is built yet.

What the harness is missing for agents that work with images, run for a long time, and split their work into parts. The first agent that needs it is Figma to DSL (`../figma-to-dsl/spec.md`), but every ticket here is general. None of them mentions Figma in its code.

## What the harness has today

- **Durable runs.** The state is saved after every step. A run resumes after an approval, a crash or a deploy (ADR 0006, ADR 0009).
- **A worker that runs agents**, and a CLI host that queues runs and follows them (ADR 0009).
- **Typed tools with zod checks**, approvals with change requests in the same run (ADR 0005), and structured output through `final`.
- **Skills, memory, evals with a pass gate, tracing and cost.**
- **Big text tool outputs stored and read back by reference** (`packages/core/src/output-store.ts`).

## What complex agents need that it doesn't have

### Tier 1: before any image or multi-step agent

| #   | Ticket                                                                                             | Status          | Blocked by |
| --- | -------------------------------------------------------------------------------------------------- | --------------- | ---------- |
| 01  | [Images in messages and tool results](issues/01-images-in-messages.md)                             | ready-for-agent | 02         |
| 02  | [Artifact store by content hash](issues/02-artifact-store.md)                                      | ready-for-agent |            |
| 03  | [Model per agent](issues/03-model-per-agent.md)                                                    | resolved        |            |
| 04  | [Runs made of code steps and agent tasks](issues/04-runs-with-tasks.md)                            | needs-triage    |            |
| 05  | [Context for long runs: shared part first, old rounds trimmed](issues/05-context-for-long-runs.md) | ready-for-agent | 01         |
| 06  | [One review per run, decisions aimed at a task](issues/06-review-per-run.md)                       | needs-triage    | 04         |
| 07  | [Evals with artifacts, images and recorded runs](issues/07-evals-with-artifacts.md)                | ready-for-agent | 01, 02     |

### Tier 2: soon after, for long and connected agents

| #   | Ticket                                                                       | Status          | Blocked by |
| --- | ---------------------------------------------------------------------------- | --------------- | ---------- |
| 08  | [Cancel a run](issues/08-cancel-a-run.md)                                    | resolved        |            |
| 09  | [Cache code steps by their inputs](issues/09-cache-code-steps.md)            | ready-for-agent | 02, 04     |
| 10  | [Tools from MCP servers](issues/10-mcp-tools.md)                             | needs-triage    |            |
| 11  | [Agents' input and output schemas for hosts](issues/11-schemas-for-hosts.md) | resolved        |            |

### Added 2026-10-30, from comparing with LangGraph

| #   | Ticket                                                                                    | Status          | Blocked by |
| --- | ----------------------------------------------------------------------------------------- | --------------- | ---------- |
| 15  | [Threads: a follow-up run carries on from the last one](issues/15-threads.md)             | ready-for-agent | memory 04  |
| 16  | [Checkpoint history: replay or fork a run from any step](issues/16-checkpoint-history.md) | resolved        |            |

Issue 04 also gained a typed run state with merge rules (LangGraph's state schema and reducers), and keeps control flow as code rather than a graph.

### Tier 3: when the numbers ask for them

| #   | Ticket                                                                                   | Status       | Blocked by |
| --- | ---------------------------------------------------------------------------------------- | ------------ | ---------- |
| 12  | [Strict tool schemas where the provider supports them](issues/12-strict-tool-schemas.md) | resolved     | 03         |
| 13  | [Outputs with variants](issues/13-output-variants.md)                                    | resolved     |            |
| 14  | [Worker and host operations](issues/14-worker-and-host-operations.md)                    | needs-triage |            |

## Order of work

1. **Start in parallel:** 02 (artifacts) and 03 (model per agent). Then 01 (images), which reads image bytes from the artifact store.
2. **04 (runs with tasks), design first.** It's the largest change and needs an ADR, so the design can begin alongside step 1.
3. **05 (context) and 07 (evals)** once images exist, then 06 (review) once tasks exist.
4. **Tier 2** as the first complex agent reaches the point of needing it: 08 before anything runs for long in front of users, 10 when an agent needs Cast, 09 and 11 when hosts and re-sends arrive.
5. **Tier 3** only when evals or operations show the need.

## Rules these tickets keep

- One path that matches production: no alternate modes, no stand-in services.
- The tenant comes from the run, never from the model or tool input.
- Don't widen `ToolContext` or `RunContext` without raising it first. Tools get new capabilities, such as the artifact store, through the tool factory's options, the way agents pass folders today.
- Nothing is published to CodeArtifact.
- Typed tools only. Writes go behind an approval.
- Whatever is built keeps a Temporal shape (a step is an activity, a task is a child workflow, a decision is a signal), so moving to Temporal swaps the engine, not the agents.
