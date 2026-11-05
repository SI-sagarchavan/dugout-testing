# 21. Databases in Docker, apps on the host, one Postgres

> **Partly superseded by [ADR 0027](0027-two-databases.md) (2026-11-05).** The `fanos` database and the
> control plane are going away: the system ends with two databases, the FanXP DB and `harness`. What
> still holds here: databases in Docker and apps on the host for local work, `harness` as its own database
> on its own instance in dev and prod, no joins across databases, and the final DSL belonging to FanXP.
> What no longer holds: `fanos` as a permanent database, Electric on it, and the control plane as the
> store for Sends.

After ADR 0020 one checkout holds everything. The question was how to run it: the databases need Docker, and the apps (API, worker, Studio, web, dugout's worker and watcher) could be containers or plain `node` processes. And the two halves had brought a Postgres each.

## Decision

Docker runs the databases only. The apps run on the host with the usual commands, so a code change is a restart, not an image build, and a debugger or `console.log` is where you expect it.

**One Postgres server, two databases.** Dugout's server (pgvector, Postgres 17, :55432) holds `harness` (agent memory, runs, approvals; roles `harness` and `dugout_app`, with row-level security) and `fanos` (the pipeline's control plane: Sends, exports, artifacts, pipeline runs; role `fanos`, which can log in and replicate but is not a superuser, so the pipeline cannot reach `harness`). Nothing queries across them; dugout's agents reach the control plane through its HTTP API. A third database, `fanos_test`, is for the API's integration tests, which delete every row they find: they refuse a database whose name does not end in `_test`. The server runs with `wal_level=logical` because Electric reads the WAL.

**One Valkey.** It runs with `noeviction`. Dugout's event stream is in database 0; the API's job queue (BullMQ) is in database 1 (`REDIS_URL=redis://localhost:56379/1`).

| service                                | profile    | what                                                                                                                                                                        |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (:55432), `valkey` (:56379) | default    | `pnpm infra up`                                                                                                                                                             |
| `pipeline-electric` (:3010)            | `pipeline` | the control plane's live sync, from `fanos`. `pnpm infra up pipeline` (it also creates the `fanos` role and databases on an existing server, with `scripts/pipeline-db.sh`) |

A fresh server creates the role and databases itself, from `docker/postgres-init/`. On a server that already exists, `scripts/pipeline-db.sh` does the same, and the `wal_level` setting takes effect when the Postgres container is next recreated.

**Moving the old data.** The `trial` stack kept its database in a Postgres 16 container (`api-postgres-1`, volume `api_fanos-pg`). `pnpm db import` copies it into `fanos` (a dump of the source, which is only read, restored into the new database); 50 exports, 296 artifacts and every other table matched row for row. It refuses to replace a `fanos` that already holds exports unless `--force` is given, and cannot replace one Electric is attached to. The old volume is not touched: keep it for a while as a backup, then remove it with `docker volume rm api_fanos-pg` once the shared server has served you for a few days.

**Running it:** `pnpm infra up pipeline`, `pnpm build` once and after pipeline changes, then `pnpm dev` (API :4100 and its worker, Studio :3000, web :3415), `pnpm worker` for the agents and `pnpm agent watch` for the Figma watcher.

**Agents and pipeline keep separate databases**, in every environment: they have different owners and lifetimes, and share no transactions or joins (agents reach the control plane through its HTTP API). A single database with two schemas was tried and dropped: it would have needed `runs` and `run_steps` kept apart anyway, and removes nothing but a connection string. Local shares a server to save a container. In dev and prod the control plane should have its own instance, because `wal_level=logical` is server-wide and a stopped Electric makes its replication slot retain WAL until the disk fills.

**The final DSL belongs to FanXP.** The published tree is stored in the existing FanXP surface database (dev and prod), through the FanXP backend's API, by a write-effect tool behind approval. `harness` and `fanos` keep a reference to it, not a second copy. This part is intended and not yet built.

## Tried and not adopted: the apps in containers

Every service ran from one image with Chromium and the built pipeline (commit `ae206e0`, which has the Dockerfile and compose profiles). The whole stack came up and a card-match run completed, but Chromium on Linux rasterises text differently from a Mac's, so scores measured in the container differ from the recorded baselines: over the 18 frames in `agents/card-match/evals/frames.ts`, 1 identical, mean difference 0.45 points, largest 1.6 (`news-later`), mostly lower in Docker, and conform error counts move too (`fixtures-strip` 23 → 33). `baseline.json` was recorded on macOS. A containerised worker is also what production will look like (Linux), so when the agents move into containers, re-record the baselines there first.
