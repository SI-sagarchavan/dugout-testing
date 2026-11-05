# 0027. Two databases: the control plane's data moves to the FanXP backend

Date: 2026-11-05 · Status: accepted (direction), needs an audit of `apps/api`'s `runs` module before removal · Supersedes the three-database parts of ADR 0021 and the control-plane input of ADR 0019. FanOS Engineering copy: ADR019 in Confluence.

## Context

Three databases exist today.

| Database | Server | Owner | Holds |
| --- | --- | --- | --- |
| `fanxp_dev` (`fanxp_master`) | shared Aurora | the FanXP backend (`wnm-fanxp-backend`) | users, clients, plugin sign-ins, the Send ledger, templates |
| `harness` | our Postgres | the agents worker | runs, run events, approvals, memory |
| `fanos` | our Postgres | the control plane (`apps/api`) | what the old Send stored (exports, artifacts), surface versions, pipeline runs, fidelity |

`fanos` exists because the Figma pipeline came from the `trial` repo with its own API, and the plugin posted the whole Send to it. ADR 0021 kept it separate from `harness` and said the final DSL belongs to FanXP's database.

Three things changed. The Send no longer goes to the control plane: files go to S3 and the record goes to the backend (`.scratch/surface-studio-fanxp/send-flow.md`). The admin app, not the old Studio on `:3001`, is where people watch runs and review results (spec P2). And the backend serves every request from the plugin and the admin app, so people-facing data belongs next to users and permissions, which only the backend knows.

## Decision

**Two databases.**

- **FanXP DB.** The backend owns it. It holds everything people see or own: users, clients, plugin sign-ins, the Send ledger, an index of saved results, surface versions, templates.
- **Harness DB.** The agents worker owns it. It holds runs (the queue), every saved run event, approvals and decisions, and agent memory.
- **`fanos` goes away.** Its modules move as in the table below.

**Bytes live in S3**, in the client's own bucket (`<client>/surface-sends/` for working files).

**The plugin and the admin app talk only to the backend.** They never read a database, S3 listings or the worker.

**The agents worker has no API.** It takes work from the run queue (ADR 0009, and Temporal after ADR 0028). The backend queues runs and decisions, and reads events from the run's Valkey stream and `run_events`. The backend does not call the worker, and the worker does not call the backend to control a run.

**The worker reaches the backend only through MCP servers.** Cast MCP exists (ADR 0026). A Surface MCP server comes next, on the same registry, lock and approval rules:

| Tool | Effect | Replaces |
| --- | --- | --- |
| `surface.getSend` | read | `plane.getExport`. Returns the manifest and a signed download URL per file. |
| `surface.getTokens` | read | the open question about tenant tokens |
| `surface.getTemplate`, `surface.getPage` | read | reading what exists before changing it |
| `surface.saveDraft` | write, approval | saving the DSL tree, preview and reports for a Send |
| `surface.publishTemplate` | write, approval | publishing: copies used images to `static-assets/template/` and creates or versions the template |

Files stay out of MCP. Tools return signed S3 URLs and keys, and the worker fetches the bytes.

**The databases never join.** They store each other's ids: the Send row holds the run id, and the run's input holds the Send id and the client code. The client code is the tenant id (spec).

**Live updates come from the backend's SSE connection, not Electric.** See ADR018 in Confluence. The worker also writes a short notice to a per-tenant Valkey stream when a run's status changes.

## Where the control plane's modules go

| `apps/api` module | Lines | Goes to |
| --- | --- | --- |
| `exports`, `artifacts` | 1,520 | the Send ledger (built) plus an index of results in the FanXP DB, bytes in S3 |
| `surfaces` | 777 | the backend's template and version tables |
| `fidelity` | 288 | a table in the FanXP DB. The scoring code stays in `@fanos/conform` and `@fanos/renderer`, which agents run in-process. |
| `projects`, `audit`, `sync` | about 620 | clients replace projects, audit moves over, Electric sync is dropped |
| `runs` | 1,918 | unknown until audited (a BullMQ job queue for the older pipeline) |

The `@fanos/*` packages (`compile`, `conform`, `renderer`, `dsl`, `tokens`) stay. Agents use them as libraries, in the worker's process, so scoring and rendering do not depend on the control plane.

## Consequences

- `card-match` and `bind` read their input from `surface.getSend` and S3, and write results through `surface.saveDraft`, instead of calling `plane.getExport`. Until that lands, the control plane keeps running.
- `apps/api`, the old `apps/surface-studio` (`:3001`) and `apps/web` (`:3000`, the preview site) are stand-ins. They retire as the admin app's Studio and the renderer's `surface_v2` branch ship. `pnpm infra up pipeline`, `pnpm db migrate fanos` and `pnpm db import` retire with them.
- The Studio inspector's data (IR, DSL, Gaps, Data and logic) must come from backend endpoints backed by S3 and the result index.
- The backend needs a route to start runs, decide approvals, cancel, list, and stream events (spec P1).
- The SSE route needs its own CloudFront behavior with compression off. CloudFront compresses `/fanxp*` today, which buffers a stream.
- The Harness DB stays on its own instance in dev and prod (ADR 0021 already asks for this).

## Not decided

- How the backend reaches the Harness DB. With Temporal (ADR 0028) it calls Temporal's client. Until then it needs a narrow role that queues runs and decisions and reads `runs` and `run_events`.
- What happens to the `runs` module of `apps/api`. Audit first.
- The table design for the result index and surface versions in the FanXP DB.
- Whether the dugout repo keeps the control plane's code until the last agent stops using it, or removes it in one change.

## Order of work

1. Apply the Send migration on `fanxp_dev` and run a live Send.
2. The backend queues the run at `complete`.
3. Surface MCP read tools (`getSend`, `getTokens`). Move `card-match` and `bind` onto them.
4. `saveDraft`, the result index, and the Studio review screens.
5. Audit and remove `apps/api` and `fanos`.
