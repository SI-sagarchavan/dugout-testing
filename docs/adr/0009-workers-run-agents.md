# 0009 — A worker runs agents; the CLI hands it runs, as the backend will

Date: 2026-10-30 · Status: accepted (until Temporal, H7)

## Context

The API ran agents inside its own process (ADR 0004). Since ADR 0006 a run's working memory is in Postgres, so runs survived a restart, but the process answering requests still ran every model call and tool.

In production that won't hold. wnm-fanxp-backend will take the admin app's requests and stream run events back, sometimes for 20 to 40 minutes. Agents need a service of their own on ECS that scales and deploys on its own. Temporal will run that part before production; until then we need a worker that looks the same from the outside, so the backend, the event stream and the agents don't change when it comes.

With the backend serving requests, the HTTP API in this repo would only have been a stand-in for it. A CLI tests the same path with less code.

## Decision

- **Two apps, no API.**
  - `apps/worker` runs agents.
  - `apps/cli` (`pnpm agent`) is the host here. It does what wnm-fanxp-backend does in production: it queues a run, follows its events, and queues a decision at each approval.

  They share only Postgres and Valkey; neither calls the other. The CLI imports the worker's queue and event code (`createRunQueue`, the event log), since in this repo it is the worker's only client.
- **The worker claims.** Every second, and whenever a run ends, it calls `claim_runs`. That is a narrow security-definer function, because finding work crosses tenants. It claims, with `for update skip locked`, runs of the agents this worker serves that are `queued`, or `running` with an expired lease. Each claimed run gets a lease of its own for one invocation, renewed by a heartbeat and fenced on every save, as in ADR 0006.
- **What a claimed run does.** It depends on what the run has:
  - a decision: resume with it (reason `approval`);
  - a checkpoint but no decision: resume (reason `recovery`);
  - nothing saved and no events: start afresh, after checking the input against the agent's schema (input that doesn't match fails the run at once, since no retry would get further);
  - nothing saved but some events: fail with `run.failed`, since its events can't be numbered again.

  The decision stays on the run until the first save after it, so a worker that dies before then leaves it for the next.
- **A run that keeps crashing is given up.** Each claim counts as an attempt; a decision resets the count. Past `maxAttempts` (3) the worker ends the run with `run.failed` and the last error ("gave up after 3 attempts: …"), so anyone following it sees it end. A crash leaves the lease to run out, which spaces the attempts.
- **Shutdown hands runs over.** On SIGTERM the worker stops claiming and gives runs in progress up to 20 seconds (`WORKER_GRACE_MS`) to end or reach an approval. Then it hands the rest over:
  - a new lease owner, so its own later saves fail;
  - an expired lease, so another worker claims the run at once and resumes it from its last save.

  A hand-over isn't an attempt. ECS's default stop timeout is 30 seconds.
- **One worker, any agents.** A worker runs every agent in `apps/worker/scripts/work.ts`, or those in `AGENTS`, so an agent can get a service of its own. `WORKER_CONCURRENCY` (10) caps runs in progress; runs mostly wait on the model.
- **A row is the queue.** No SQS or BullMQ: the run row is already the source of truth with leases, and a separate queue would have to be kept consistent with it. Temporal replaces the claiming, leases and checkpoints before production; the run row stays as the host's index.
- **The CLI follows, then asks.** It shows the run's events as they stream, stops where the invocation ends (`approval.requested`, `run.completed`, `run.failed`) and asks y / n / change. If no worker picks a queued run up within 5 seconds, it says to start one. Ctrl-C leaves the run in its worker; `pnpm agent --run <runId> --tenant <t>` attaches again and asks only about the approval still open. A run that ended and whose live stream expired replays from Postgres.
- **Deployment.** `apps/worker/Dockerfile` builds the image, with one process and no port. `VALKEY_KEY_PREFIX` puts the stream keys in a shared cluster's namespace (`fanos:<env>:dugout:`).

## The contract a host follows

What wnm-fanxp-backend does against the same database and Valkey (`apps/worker/src/queue.ts` is the reference):

- **Start a run.** Insert into `runs` with status `queued`, the tenant, the agent id and the input, already checked against the agent's input schema.
- **Decide an approval.** When the run is `waiting` and its checkpoint waits for that call, set it back to `queued` with the decision in `runs.decision` and `attempts` reset to 0. Check both in one statement, so two decisions can't both win.
- **Follow a run.** Read the Valkey stream `run:<id>:events`, whose entry ids are `0-<seq>`; resume after a known `seq` with an exclusive range. An invocation ends at `approval.requested`, `run.completed` or `run.failed`. `run_events` in Postgres has every event except the streamed fragments (`token`, `tool.input.delta`).
- **Run status.** The `runs` row says `queued`, `running`, `waiting`, `completed`, `rejected` or `failed`. A run is saved as `waiting` before its `approval.requested` is written, so a decision sent the moment the event arrives finds it.

## Consequences

- Local work needs `pnpm worker` next to `pnpm agent`. Evals and `pnpm smoke` still run the agent in their own process.
- The per-request response modes of ADR 0008 (`stream`, wait, `background`) left with the API, along with the per-agent default and the JWT dev tokens. How the backend answers its own clients is the backend's choice.
- A worker deploy hands its runs to the other workers, and anyone following a run doesn't see it: the events come from Valkey and go on without a gap. Checked live: a worker stopped mid-run with a 500 ms grace, and a second one resumed at the same step without repeating finished tool calls.
- A run waits up to a second to be claimed after it is queued or decided. A Postgres `NOTIFY` can remove that if it matters.
- A model call in flight at a hand-over or crash is paid for twice.
- Tests that run a worker get a database of their own (`ownDatabaseSetup`), since a worker claims any queued run it can.
- This supersedes ADR 0004, and ADR 0006's recovery sweep (`claim_expired_runs` is replaced by `claim_runs`).
- Not yet:
  - one Valkey reader per host process, instead of one per stream;
  - a cancel command;
  - a queue-depth metric for autoscaling;
  - a smaller image (713 MB, with dev dependencies).
