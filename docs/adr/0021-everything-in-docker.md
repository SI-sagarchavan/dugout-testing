# 21. The whole stack runs in Docker

After ADR 0020 one checkout holds everything, but running it still meant a Postgres and Valkey in Docker plus five or six `node` processes started by hand in the right order, from the right directories, with the right ports and URLs. The pipeline's own compose file lived apart from dugout's.

## Decision

`docker-compose.yml` at the root runs all of it, in profiles so the default is unchanged (`docker compose up` is dugout's Postgres and Valkey, which `pnpm check` needs):

| profile          | services                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)           | `postgres` (:55432), `valkey` (:56379)                                                                                                                     |
| `pipeline-infra` | `pipeline-postgres` (:5433, `wal_level=logical`), `pipeline-redis` (:6379), `pipeline-electric` (:3010): the pipeline's databases for apps run on the host |
| `pipeline`       | the three above, plus `pipeline-migrate`, `pipeline-api` (:4100), `pipeline-worker`, `pipeline-studio` (:3000), `pipeline-web` (:3415)                     |
| `agents`         | `dugout-migrate` (migrate + seed), `worker`                                                                                                                |
| `watch`          | `watcher` (`pnpm card:watch`)                                                                                                                              |

`pnpm stack:up` starts `pipeline` and `agents`; `stack:watch`, `stack:down`, `stack:logs` and `stack:build` do the rest. Every host port has a variable (`PIPELINE_API_PORT`, `PIPELINE_STUDIO_PORT`, `DUGOUT_PG_PORT`, ...), so a second stack can run beside the first with `docker compose -p <name>`.

- **One image, `dugout-stack`** (`docker/Dockerfile`): Node 22, Playwright's Chromium at the version the workspace pins, the installed workspace and the built pipeline. Every service runs it with its own command. It is not the ECS image (`apps/worker/Dockerfile`, Alpine, no browser), which cannot run the card agents' renderer.
- **Nothing secret in the image.** `.dockerignore` keeps every `.env` and the blob store out. The pipeline's config is in the compose file; dugout's comes from `.env` (`AWS_PROFILE`, `AWS_REGION`) and `~/.aws`, mounted read-only, so Bedrock works through an SSO profile.
- **State on the host or in volumes.** The control plane's artifacts are `pipeline/apps/api/.blobs`, mounted into the API and worker. The card agent's preview files (`pipeline/packages/{dsl,renderer}/fixtures/preview`) and `.runs/` are mounted into the services that write and read them.
- **The control-plane database moves with a dump.** The old stack's data lives in the `api_fanos-pg` volume. Eval frames are exports in that database, so restore it before the evals mean anything:
  `docker exec api-postgres-1 pg_dump -U fanos -Fc fanos > fanos.dump`, then
  `docker exec -i dugout-pipeline-postgres-1 pg_restore -U fanos -d fanos --clean --if-exists --no-owner < fanos.dump`
  and restart `pipeline-api` and `pipeline-worker`. One error, `publication "electric_publication_default" already exists`, is harmless.
- **The web app finds its fixtures from its working directory**, not from its own file path, which a production build moves; and it reads them on every request, since the card agent rewrites them.

## Numbers differ from a Mac

Chromium on Linux rasterises text differently from Chromium on macOS, and the geometry gate measures with it. The 18 frames in `agents/card-match/evals/frames.ts`, measured once on the host and once in the container on the same data: 1 identical, mean difference 0.45 points, largest 1.6 (`news-later`), mostly lower in Docker, with text-heavy frames furthest. Conform error counts move too (`fixtures-strip` 23 → 33). `baseline.json` was recorded on macOS. Production runs on Linux, so numbers from the container are the closer to it; compare a Docker run with a Docker baseline, not with `baseline.json`, until it is re-recorded there.
