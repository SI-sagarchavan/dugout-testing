# 0004 — API runs agents in-process; event log on Valkey and Postgres

Date: 2026-10-29 · Status: superseded by ADR 0009 (the API is gone; a worker runs agents). Restart behaviour was superseded first by ADR 0006

## Decision

- `POST /runs` verifies a JWT, takes the tenant from its `tenant_id` claim, records the run in Postgres and starts it in the API process. It returns the run id at once.
- Every event goes to a Valkey stream `run:<id>:events` whose entry ids are `0-<seq>`, and to Postgres `run_events` as the permanent record. Token events go only to Valkey.
- `GET /runs/:id/stream` serves SSE with `id: <seq>`. A client resumes with `Last-Event-ID` (or `?lastEventId=`) and gets an exclusive range after that id, then the live tail: no gaps and no duplicates. A heartbeat comment goes out every 15 seconds. Streams expire from Valkey 7 days after the run ends, and later reads replay from Postgres without tokens.
- `POST /runs/:id/approvals/:callId` resolves a waiting approval. The approver is the token's subject. (Since ADR 0006 it resumes the saved run instead of resolving an in-memory wait.)
- The loop registers an approval wait before it emits `approval.requested`, so an approver reacting to the event at once always finds it.
- Local tokens are HS256 with a dev secret (`pnpm token`). Only the key source changes for FanOS auth.

## Consequences

- A run lives as long as the API process. A restart loses runs in flight, including pending approvals, and leaves them `running` in Postgres. (ADR 0006 fixes this: runs' working memory is saved in Postgres, approvals end the invocation, and expired leases are picked up again.) Temporal (H7) fixes this when it's brought back: the loop already runs over `Steps`, so it moves into a workflow unchanged.
- Event `seq` is assigned in process, which is safe while one process owns a run.
