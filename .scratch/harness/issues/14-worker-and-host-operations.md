# 14 · Worker and host operations

Status: needs-triage
Type: task

## What

Operational items left open in ADR 0009, and from the infra review. Each is small; take them when the need shows:

- **Queue-depth metric.** Runs waiting to be claimed, and their age, published for ECS autoscaling and alarms.
- **One Valkey reader per host process.** Today each followed stream opens its own blocking connection. With 20 to 40 minute streams, a host following hundreds of runs needs one reader that reads all its streams and hands events out.
- **Smaller worker image.** It's 713 MB today, with dev dependencies.
- **Waking workers at once.** A Postgres `NOTIFY` when a run is queued or decided, instead of waiting up to the 1-second poll.
- **A Valkey cluster of our own for run streams.** Surface prod's cluster evicts with `allkeys-lru`, which can drop a live stream. Use `volatile-lru` and a memory alarm.
- **Shorter stream retention:** a day instead of 7, since Postgres keeps the record.

## Why

None of these block building agents, but they matter before real traffic.

## Done when

- Each item is done or explicitly deferred, with a line in ADR 0009's "Not yet" list kept current.

## Pointers

- ADR 0009 ("Not yet"), `apps/worker/src/event-log.ts`, `apps/worker/src/worker.ts`, `apps/worker/Dockerfile`
- `si-build-iac/surface/prod/us-east-1/main.tf` (`module "valky"`, default `maxmemory-policy allkeys-lru`)
