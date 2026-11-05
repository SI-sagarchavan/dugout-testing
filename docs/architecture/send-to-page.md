# Send to page: from a Figma frame to a live page

How one press of Send in the Figma plugin becomes a reviewed, data-bound page section. This page lists every component, who owns which data, the full flow, and what is built. Last updated 2026-11-05.

Decisions behind it: [ADR 0027](../adr/0027-two-databases.md) (two databases), [ADR 0028](../adr/0028-temporal-runs-agent-runs.md) (Temporal), [ADR 0009](../adr/0009-workers-run-agents.md) (the worker), [ADR 0025](../adr/0025-subagents.md) and [ADR 0026](../adr/0026-mcp-servers-by-capability.md). The same material, for the wider team, is in Confluence (FanOS Engineering, HLD003, ADR017, ADR018, ADR019). Plans and working notes are in `.scratch/surface-studio-fanxp/` (`spec.md`, `send-flow.md`, `plugin-auth.md`).

## The idea in five lines

1. A designer presses Send. The plugin uploads the frame's files straight to S3 and tells the FanXP backend.
2. The backend queues a run. AI agents on their own ECS service compile the frame, compare their render with the designer's screenshot, fix what differs, and find or build the data feed in Cast.
3. People watch the run in Surface Studio (an admin app tool), answer when an agent asks, and approve the result.
4. Approving publishes a template. Someone places it on a page in the Layout Builder.
5. The site renderer draws the page with live Cast data. No agent runs at that point.

Two databases hold the state. The FanXP DB holds what people see and own. The Harness DB holds agent runs. Files live in S3.

## Components

### Services

| Component | What it does | Where |
| --- | --- | --- |
| Figma plugin | Signs the designer in, checks a frame, hashes and uploads its files, starts the Send | `dugout/packages/surface-canvas` |
| Admin app, Surface Studio | Approves plugin sign-ins, shows sends and runs, answers approvals, reviews, publishes | `wnm-fanxp-frontend`: `apps/fanxp` (`features/connect-plugin` is built), `apps/surface-studio` (planned, spec P2) |
| FanXP backend | The only API the plugin and the admin app call. Signs uploads, keeps the Send ledger, queues runs, streams events, hosts Cast MCP and Surface MCP | `wnm-fanxp-backend` (branch `feat/surface-plugin-auth`) |
| Agents worker | Runs the agents: model calls, tools, compiling, rendering in a headless browser | `dugout/apps/worker`, on its own ECS service, no port |
| Cast | The data platform. Agents find or build "hooks" there. | served by the backend over MCP |
| Amazon Bedrock | The models (Claude) | AWS |
| `fanxp-web-renderer` | Renders the published page for visitors | existing service |
| Layout Builder, Publish All Changes | Places a template on a page and snapshots it | existing admin features |

### Stores

| Store | Owner | Holds |
| --- | --- | --- |
| FanXP DB (`fanxp_dev` in dev, `si-build-shared-stg-aurora`) | the backend | users, clients, plugin sign-ins, the Send ledger, an index of saved results, templates and versions |
| Harness DB (`harness`) | the worker | runs (the queue), saved run events, approvals, `run_messages`, memory |
| S3, the client's own bucket | storage only | the bytes: IR, screenshots, art, backgrounds, agent results |
| Valkey | shared | one live event stream per run, including streamed text |

The control plane (`apps/api`, database `fanos`) is retiring (ADR 0027). Agents still read their input from it until Surface MCP lands.

### Dugout code the flow uses

| Package or app | Role |
| --- | --- |
| `apps/worker` | claims runs, runs agents, writes events to Valkey and `run_events` |
| `apps/cli` (`pnpm agent`) | the terminal host: queues runs, follows events, asks at approvals. It does what the backend will. |
| `packages/core` | the agent loop, tool pipeline, run hooks, Bedrock client, stop reasons |
| `packages/contracts` | the zod contracts: AgentSpec, Tool, RunEvent, Steps |
| `packages/db` | Postgres pool, `withTenant` (row-level security), migrations |
| `packages/memory` | semantic and episodic memory, skills, context builder |
| `packages/mcp` | MCP registry (`config/mcp/<server>.json`), locks, grants. `surfaceTokenStore` reads the backend's grants. |
| `packages/sdk` | `defineAgent`, subagents (ADR 0025) |
| `packages/tracing`, `packages/evals` | spans to Langfuse, eval suites |
| `@fanos/tokens`, `dsl`, `compile`, `conform`, `renderer` | the libraries agents use in-process: tokens, the DSL, Frame IR to DSL, the geometry gate, the renderer and pixel harness |
| `agents/send-to-page` | the parent run for one Send. Its one tool, `page.build`, runs `card-match` then `bind` in code. One approval covers the children's writes. |
| `agents/card-match` | compiles, renders, compares, fixes. Asks a person what the frame cannot show. |
| `agents/bind` | binds the design to data. Starts `cast-researcher`, and `cast-builder` when no hook fits. |
| `agents/cast-researcher`, `agents/cast-builder` | find, or build, a `dugout_` Cast hook |

Stand-ins that retire (ADR 0027): `apps/api` (`:4100`), `apps/surface-studio` (`:3001`), `apps/web` (`:3000`, the preview site).

## The flow

```
  Figma plugin                         Admin app (Surface Studio)
       |                                         |
       +--------------------+--------------------+
                            | HTTPS, plus one SSE connection per open panel
                            v
                FanXP backend (ECS) -----------------> FanXP DB
                  |        |       ^
      queues runs |  reads |       | MCP calls (Cast, Surface) with the person's grant
                  v events v       |
              Harness DB  Valkey <-+------- Agents worker (ECS, no port) --> Bedrock
                  ^                              |
                  +------- takes queued runs ----+
                                                 |
   plugin PUTs files ----> S3 client bucket <----+ reads Send files, saves results
```

| # | Step | What happens | State |
| --- | --- | --- | --- |
| 1 | Sign in | The designer presses Connect. The browser opens the admin app, the designer approves, and the plugin gets a token that works only for plugin calls (PKCE, finished by polling). | built |
| 2 | Check | The plugin reads the frame and asks `POST /surface/sends/check` whether it is a FanOS design for the chosen client. | built |
| 3 | Send | The plugin hashes each file and calls `POST /surface/sends`. The backend records the Send and returns a signed PUT URL for each file S3 does not hold. The plugin uploads each file, then calls `/complete`. The backend checks each object's size and SHA-256 and marks the Send `received`. | built, migration pending |
| 4 | Queue the run | At `complete` the backend queues a `send-to-page` run (Send id, client code) and stores the run id on the Send. | to build |
| 5 | Worker takes it | The worker claims the run and holds a lease. After a crash another worker resumes from the last save. Temporal replaces this (ADR 0028). | built |
| 6 | Agents work | `card-match`, then `bind` with its child runs. | built, reads the old control plane |
| 7 | People watch and answer | Events stream to the panel. A run that needs a person waits under "Needs you". The backend records the decision and the run resumes. | CLI only |
| 8 | Results saved | Agents save the DSL tree, preview and reports through `surface.saveDraft`. Bytes go to S3, an index row to the FanXP DB. | to build |
| 9 | Review and publish | A reviewer opens the preview with the tenant's theme and live Cast data and approves. `surface.publishTemplate` copies the used images to `static-assets/template/` and creates or versions the `surface_v2` template with its Cast binding. | to build |
| 10 | Live | Someone places the template in the Layout Builder and presses Publish All Changes. `fanxp-web-renderer` fetches the hook's data through `workflowId` and renders it. | existing platform |

## The Send in detail

Base URL: `PATH_PREFIX + /api/v1` (locally `http://localhost:4000/fanxp/api/v1`). Replies use the envelope `{ data, meta }`.

**Sign-in** (details in `.scratch/surface-studio-fanxp/plugin-auth.md`): `POST /surface/auth/sessions`, `GET` and `POST .../sessions/:id/approve|deny` from the admin app, `POST /surface/auth/token`, `/refresh`, `/revoke`, `GET /surface/tenants`, `POST /surface/sends/check`. The plugin token lasts 1 hour and has scope `surface:plugin`, which the dashboard's own auth refuses. The backend looks up the person's access to the client on every call.

**What a Send carries:**

| Kind | What it is | Types |
| --- | --- | --- |
| `ir` | the frame as JSON | `application/json` |
| `screenshot` | section pictures and the whole-frame picture, for the pixel comparison | `image/png` |
| `vector` | art the IR cannot describe: fixed crests, icons, swooshes, masks | `image/png`, `image/svg+xml` |
| `background` | images the designer marked, as their original bytes, with the node they paint | PNG, JPEG, WebP, SVG |

Content photos do not ship. The plugin skips every `art-image-*` picture, and `bind` fills those images from data. Limits: 25 MB per file, 100 MB and 1,000 files per send. The plugin reads each background's type from its bytes and refuses one the backend does not take (GIF) with a message naming the file.

**The three calls:**

| Call | Does |
| --- | --- |
| `POST /surface/sends` (plugin token) | Checks access and the manifest, looks at S3 for each file, records the Send as `uploading`, returns `sendId`, `expiresIn` (900 s), one `uploads` entry per missing file (`name`, `url`, `headers`) and `present`. |
| `PUT <url>` to S3 | The file's bytes with exactly the returned headers: `Content-Type`, `x-amz-checksum-sha256`, `x-amz-tagging`. Those and the length are signed. No token goes to S3. |
| `POST /surface/sends/:id/complete` (plugin token) | Only the sender may complete it, and access is checked again. Reads each object's size and SHA-256 from S3. If all match the Send is `received`, otherwise 409 names every file that is missing or wrong. Calling it again changes nothing. |

Errors: `SURF_19` invalid manifest (422), `SURF_20` send not found (404), `SURF_21` incomplete (409), `SURF_22` client has no bucket or upload path (503), plus `SURF_08` and `SURF_09` (token, client).

**Where files go.** Each client has a bucket and folder in `site_master.site_configuration.aws` (`bucket`, `asset_upload_path`, for example `si-build-fanxp-dev-assets` and `ibl/static-assets/`). In dev, 163 sites use `si-build-fanxp-dev-assets` and 167 use `si-waf-asset-fanxp`. CloudFront serves only `/static-assets/*` and `/*.xml` from them, and public access is blocked, so other folders are private.

| | Working files | Published assets |
| --- | --- | --- |
| Key | `<client>/surface-sends/<ab>/<cd>/<sha256>` | `<asset_upload_path>template/<name>.<ext>` |
| Public | no | yes, as `static-assets/template/...` |
| Written by | the plugin, through a presigned PUT | the backend on approval, through the existing `imageUploadWrapper(..., 'template')` |
| Lifetime | tagged `kind=surface-send`, expired by a lifecycle rule on that tag (about 60 days) | permanent |

Working keys are content-addressed, so a re-sent frame uploads only what changed.

**Tables** (migration `20261105120000`, not yet applied to `fanxp_dev`): `fanxp_master.surface_sends` and `fanxp_master.surface_send_files`.

## Agents and tools

An agent reaches other systems only through MCP servers in `config/mcp/<server>.json`, each pinned by a lock. Every tool has an effect, and write tools need approval. The connection belongs to a person, the client is named on every call, and the backend checks that person's access each time.

| Server | Tool | Effect | State |
| --- | --- | --- | --- |
| Cast | list, describe, run and build hooks | read, write | built |
| Surface | `surface.getSend`, `getTokens`, `getTemplate`, `getPage` | read | to build |
| Surface | `surface.saveDraft`, `surface.publishTemplate` | write, approval | to build |

Files stay out of MCP: tools return signed S3 URLs and keys.

## Events, reloads and live updates

Each run event has a `seq` that only goes up. The worker writes every event to the run's Valkey stream (`run:<id>:events`, entry id `0-<seq>`). It also writes every event except `token` and `tool.input.delta` to `run_events` in the Harness DB.

| Event | Valkey | `run_events` |
| --- | --- | --- |
| `token`, `tool.input.delta` (text as the model writes it) | yes | no |
| `step.completed` (the whole message of a turn), `tool.started`, `tool.completed`, approvals, run start and end | yes | yes |

Streamed text is not lost. `step.completed` carries the full message and `run_events` keeps it. Valkey keeps the whole stream, text pieces included, during the run and for 7 days after it ends (`RETAIN_SECONDS`).

**Reloading mid-run.** The panel asks the backend for the run. The backend reads saved events from `run_events` up to some seq and the panel draws that history. The panel then opens its SSE connection "after seq N". The backend reads the Valkey stream from N+1, which includes streamed text from the turn in progress, and then sends new events as they arrive. After a dropped connection the browser reconnects with `Last-Event-ID`. A `tool.started` without its `tool.completed` is a tool in progress, and a last event of `approval.requested` means the run waits for a person. After a worker crash mid-turn the cut-off text stays in Valkey and the next worker redoes the turn. `pnpm agent attach --run <id>` already behaves like this, including the fallback to Postgres after the stream expires.

**Lists.** The same SSE connection carries short change notices from a per-tenant Valkey stream, written by the worker (run status) and the backend (Send received, draft saved, template published). Electric is not used (ADR018). Each backend process keeps one Valkey reader and sends heartbeats about every 20 seconds. The SSE route needs its own CloudFront behavior with compression off, because CloudFront compresses `/fanxp*`.

## What each screen shows

| Screen | Shows | From, always through the backend |
| --- | --- | --- |
| Plugin, Runs tab | its sends and status | Send ledger, then run status |
| Studio, sends and runs lists, "Needs you" | live lists | FanXP DB and Harness DB, kept current by change notices |
| Studio, run thread | messages, tool calls, results, approvals, live text | `run_events`, then the Valkey stream |
| Studio, review | preview with theme and live Cast data, reports | result index (FanXP DB), files in S3 |

## Running it locally

1. Tunnel to the staging database: `aws ssm start-session --target i-0525de86c9a776297 --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "portNumber=5432,localPortNumber=9991,host=<writer endpoint of si-build-shared-stg-aurora>" --profile si-build` (see `wnm-fanxp-backend/docs/aurora-read-write-split.md`). It closes by itself from time to time.
2. Backend: `npm run dev` in `wnm-fanxp-backend` (port 4000). Migrations: `npm run migrate:up`. `fanxp_dev` is shared, so check `migrate:status` first.
3. Admin app: `apps/fanxp` on port 5555, with `SURFACE_ADMIN_URL=http://localhost:5555` set for the backend.
4. Plugin: `npm run build` in `packages/surface-canvas`, then load it in Figma. Base URL and login origin are in `src/api/origin.ts` and `manifest.json` (`networkAccess.allowedDomains`, which includes `https://*.s3.us-east-1.amazonaws.com`).
5. Dugout `.env`: `CAST_MCP_URL`, `SURFACE_API_URL`, `SURFACE_SERVICE_KEY`, all on the same backend. `pnpm infra up`, `pnpm worker`.

The Figma desktop app's DevTools (Plugins, Development, Open console) show the plugin's requests in the Network tab and its `[fanos-studio]` log lines.

## Verified so far (2026-11-05)

- Plugin: 419 tests pass. Backend Send routes, services and S3 signer tests pass (31 for the Send service, and the full routes, services and utils suites at 686 tests).
- Real S3 (`si-build-fanxp-dev-assets`, client `sb`), using the backend's signer and the plugin's real hashing and upload code: 5 files uploaded and verified by size and SHA-256 with the `kind=surface-send` tag. S3 refused tampering: wrong bytes of the right length gave `400 BadDigest` and stored nothing, and a wrong length, content type, tag or checksum gave `403 SignatureDoesNotMatch`. The test objects were deleted.
- A live Send from Figma reached the backend, passed auth, the access check, validation, the S3 checks and URL signing, and stopped at the missing `surface_sends` table.

## Open items

- Apply the Send migration to `fanxp_dev` and run a full live Send.
- Add a CORS rule for origin `null` (Figma's sandbox) to each client bucket if the first live upload shows Figma enforces it, and a lifecycle rule on tag `kind=surface-send`. Give the backend role PutObject, PutObjectTagging and GetObject on `*/surface-sends/*`, and the worker role GetObject.
- Decide whether Sends cover the 167 sites on `si-waf-asset-fanxp` (its CORS, lifecycle and IAM are unchecked).
- Measure hashing time inside Figma's sandbox. 19.7 MB took 0.37 s in Node, and the sandbox is slower. The plugin logs `read`, `hashed` and upload times to its console.
- Build: queue the run at `complete`, Surface MCP, the SSE route and approval routes, the result index, the Studio screens, publish.
- Audit `apps/api`'s `runs` module, then retire `apps/api` and `fanos`.
- Temporal spike and hosting decision (ADR 0028).
