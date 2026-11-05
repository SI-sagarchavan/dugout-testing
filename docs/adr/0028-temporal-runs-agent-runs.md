# 0028. Temporal runs agent runs; AgentCore and Trigger.dev are not adopted

Date: 2026-11-05 · Status: proposed · Replaces the claiming, leases and checkpoints of ADR 0006 and ADR 0009 ("until Temporal, H7") when it lands. FanOS Engineering copy: ADR017 in Confluence.

## Context

A run of `section-builder` lasts minutes, makes hundreds of model calls, starts child runs, and stops for hours or days while a person approves. Today the worker keeps runs safe itself, with Postgres row leases, checkpoints and attempt counts (ADR 0006, ADR 0009). ADR 0009 calls that temporary and says Temporal replaces it before production.

## Decision

Agent runs become Temporal workflows. The agents worker stays on its own ECS service with no port, and polls a Temporal task queue. The FanXP backend starts, signals, queries and cancels runs through Temporal's TypeScript client. The run row and the event log stay (below). Until Temporal is in, the Postgres-lease worker keeps working for development.

| Today                                                        | With Temporal                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| The backend inserts a `queued` row in `runs`                 | The backend starts a `sectionBuilder` workflow, with the run id as the workflow id |
| The worker calls `claim_runs` every second and holds a lease | The worker polls a task queue                                                      |
| Checkpoints, heartbeats, attempt counts                      | Temporal records each step and replays the history on another worker after a crash |
| An approval writes `runs.decision` and queues the run again  | The backend sends a signal. The workflow waits for it with no worker held.         |
| Child runs, "retry a failed build up to three times"         | Child workflows and retry policies                                                 |
| Cancel                                                       | Workflow cancellation                                                              |

## Options considered

**Temporal (chosen).** It replaces the part we would otherwise keep building. The code that decides what happens next becomes deterministic workflow code, and each model call and tool call becomes an activity. Our agent code runs in our own ECS workers. Temporal hosts only the orchestration state.

**AWS Bedrock AgentCore (not adopted).** Most of it duplicates what we run:

| AgentCore service          | What we have                                     |
| -------------------------- | ------------------------------------------------ |
| Runtime (microVM sessions) | the ECS worker                                   |
| Memory                     | `packages/memory`                                |
| Gateway                    | the MCP registry, Cast MCP, Surface MCP          |
| Identity                   | the backend's MCP grants and `surfaceTokenStore` |
| Browser                    | Playwright in the worker                         |
| Observability              | Langfuse tracing                                 |

Runtime is the one new piece and it does not solve the wait. As we understand AWS's published limits (check the current ones), a session ends after about 15 minutes idle and lasts at most 8 hours, so a run waiting overnight for an approval still needs our own pause and resume. The managed browser also does not suit pixel scoring, which needs one fixed rendering setup (macOS to Linux already moves scores by up to 1.6 points on the eval frames).

**Trigger.dev (not adopted for now).** The code change is smaller than Temporal's, because tasks are plain async TypeScript with no determinism rules, and `wait.forToken` fits an approval: the backend creates a waitpoint token and completes it when a person decides. The catch is where code runs, from Trigger.dev's documentation:

|                               | Cloud                                                | Self-hosted                                                                                                                  |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent code runs               | on Trigger.dev's machines (no cloud or region named) | in our setup                                                                                                                 |
| A run waiting for an approval | checkpointed and paused, not charged                 | no checkpoints, so most likely it keeps its machine (our inference; the docs do not say)                                     |
| What we operate               | nothing                                              | the web app, Postgres, Redis, the supervisor and runners on Docker Compose or Kubernetes (no ECS mentioned), no auto-scaling |

On Cloud, Bedrock credentials, MCP grants, tenant data and Send files would leave our AWS account. Self-hosted keeps them in but loses checkpoints, which are what make long approval waits cheap. A failed attempt restarts from the beginning, reusing only finished subtasks, so dugout's own save points would still be needed. Revisit if running agent code outside our AWS account becomes acceptable.

**AWS Step Functions or Lambda durable functions (not evaluated in depth).** The fallback if Temporal's hosting or cost is not acceptable. Runs need a headless browser and long model calls, which suit ECS better than Lambda.

**Keep the Postgres leases (development only).** It works and is tested from the command line. For production we would own crash recovery, replay, timers and long waits ourselves.

## What changes in the Harness DB

These come from `packages/db/migrations/002` to `012`.

**Removed (Temporal does this job):**

| Object                                                              | Migration     | What it did                                                                                           |
| ------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `claim_runs()` function                                             | 003, 009, 012 | the worker's claim every second                                                                       |
| `runs.lease_owner`, `runs.lease_until`, index `runs_expired_leases` | 002           | which worker holds a run, and until when                                                              |
| `runs.attempts`, `runs.last_error`                                  | 003           | give up after 3 crashes, with the last error                                                          |
| `runs.decision`                                                     | 003           | the approval a queued run resumes with                                                                |
| index `runs_queued`                                                 | 003           | find queued runs                                                                                      |
| `run_checkpoints`                                                   | 002, 010      | one save point per run, for crash recovery                                                            |
| worker code                                                         | n/a           | the claim loop, lease heartbeats, fencing on each save, the three-attempt rule, the SIGTERM hand-over |

**Kept:**

| Object                                                                                      | Why                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the `runs` row (id, tenant, agent, input, result, status, model, parent ids, cancel fields) | the backend's index: lists, "Needs you", permissions. The workflow updates status through an activity.                                                                            |
| `run_events`                                                                                | the permanent thread the panel shows after a reload. Temporal keeps history only for its retention period and is not built to be queried by a UI.                                 |
| `run_messages`                                                                              | transcripts are large. Keeping them here and passing ids through Temporal keeps each workflow's history under its size limit (about 50,000 events or 50 MB; payloads about 2 MB). |
| row-level security policies and the `dugout_app` role                                       | they still guard each tenant's rows                                                                                                                                               |
| Valkey streams                                                                              | they still carry live text                                                                                                                                                        |
| `memory_items` and what migrations 004 to 007 and 011 add                                   | memory has nothing to do with running a run                                                                                                                                       |

**Undecided:** `run_checkpoint_history` and `prune_run_history()` serve `pnpm agent history` and `pnpm agent fork` (ADR 0016). Temporal can reset a workflow to an earlier point, but that re-runs the same workflow and does not create a fork on another model. Either keep the table, or rebuild a fork from `run_messages`. A checkpoint holds more than the transcript (budget used, pending approvals), so check that first. Settle it in the spike.

**Order.** Do not drop anything on the day Temporal arrives. Run new runs on Temporal, let runs on the old path finish, then drop the objects in one migration.

## Consequences

- The agent loop in `packages/core` splits into a deterministic workflow and activities.
- The backend uses Temporal's client to start, signal and cancel runs, instead of writing to `runs`. This also settles how the backend reaches the Harness DB for run control (ADR 0027).
- Events still go to Valkey and `run_events`, so the panel and the SSE route do not change.
- Temporal Cloud costs money per action. Self-hosting means operating Temporal's services and database.
- Workflow code must be deterministic. Long runs need continue-as-new, and files travel as S3 keys, which the design already does.

## Follow-up

- Spike: run `section-builder` as a workflow with one approval signal and one child workflow.
- Decide Temporal Cloud or self-hosted, with a cost per run.
- Decide `run_checkpoint_history` and forks.
- Split the loop, retire the objects above, move the backend to the Temporal client.
