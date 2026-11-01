# 21. Databases in Docker, apps on the host

After ADR 0020 one checkout holds everything. The question was how to run it: the databases need Docker, and the apps (API, worker, Studio, web, dugout's worker and watcher) could be containers or plain `node` processes.

## Decision

Docker runs the databases only. The apps run on the host with the usual commands, so a code change is a restart, not an image build, and a debugger or `console.log` is where you expect it.

`docker-compose.yml`:

| service                                                  | profile    | what                                                                             |
| -------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `postgres` (:55432), `valkey` (:56379)                   | default    | dugout's memory, runs and event stream. `pnpm infra:up`; what `pnpm check` needs |
| `pipeline-postgres` (:5433), `pipeline-electric` (:3010) | `pipeline` | the control plane's database and its sync service. `pnpm pipeline:infra:up`      |
- **The control-plane database is the old one.** `pipeline-postgres` mounts the Docker volume `api_fanos-pg` as an external volume: the volume the `trial` stack created (container `api-postgres-1`), with every Send, export and artifact record in it. Nothing is migrated, and the eval frames (exports in that database) still resolve. The volume belongs to Docker, not to the `trial` folder, so deleting that folder does not touch it, and `docker compose down -v` leaves an external volume alone. Never run the old container and this one together: two Postgres servers on one data directory corrupt it. Stop the old stack first: `docker stop api-postgres-1 api-electric-1`.
- **One queue server.** The API's job queue (BullMQ) uses dugout's Valkey, database 1 (`REDIS_URL=redis://localhost:56379/1`); dugout uses database 0. Valkey runs with `noeviction`, which BullMQ wants. The pipeline has no Redis of its own.
- **Running it:** `pnpm infra:up && pnpm pipeline:infra:up`, `pnpm pipeline:build` once and after pipeline changes, then `pnpm pipeline:dev` (API :4100 and its worker, Studio :3000, web :3415), `pnpm worker` for the agents and `pnpm card:watch` for the Figma watcher.

## Tried and not adopted: the apps in containers

Every service ran from one image with Chromium and the built pipeline (commit `ae206e0`, which has the Dockerfile and compose profiles). The whole stack came up and a card-match run completed, but Chromium on Linux rasterises text differently from a Mac's, so scores measured in the container differ from the recorded baselines: over the 18 frames in `agents/card-match/evals/frames.ts`, 1 identical, mean difference 0.45 points, largest 1.6 (`news-later`), mostly lower in Docker, and conform error counts move too (`fixtures-strip` 23 → 33). `baseline.json` was recorded on macOS. A containerised worker is also what production will look like (Linux), so when the agents move into containers, re-record the baselines there first.
