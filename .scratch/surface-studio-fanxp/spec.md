# Surface Studio inside FanXP: plan

Status: needs-triage

**Decisions since this was written (2026-11-05).** The current flow and component list is
`docs/architecture/handoff-flow.md`.
- The control plane (`apps/api`, `fanos`) goes away, so the "control plane" parts below (the Handoff arrow
  in the target shape, "control-plane reads, proxied" in P1, open question 1) are superseded by
  `docs/adr/0027-two-databases.md`. Exports and artifacts become the Handoff ledger, an index of results in the
  FanXP DB, and files in S3, reached by agents through a Surface MCP server.
- P5's Temporal item is now `docs/adr/0028-temporal-runs-agent-runs.md`.
- The Handoff itself changed: presigned S3 uploads and a ledger in the backend (`handoff-flow.md`).
- Run events reach the panel over SSE with no Electric (Confluence ADR018).

Surface Studio becomes a tool in the FanXP admin (`wnm-fanxp-frontend`), at
`https://dev-fanxp.sportz.io/#/<tenant>/surface-studio`, opened from a tile on the tenant home. It
is where agent runs start (a Figma Handoff), are followed live, reviewed and approved, and where
the section templates they make are kept and placed on pages. After that, the site's renderer
(`fanxp-web-renderer`) draws those templates as a V2 template type with live Cast data.

Order: the dashboard and control plane first, the site renderer after. Single-section templates
only; multi-section pages stay deferred (`.scratch/data-binding/sections.md`).

## What already exists (checked 2026-11-04)

| Where                | What we reuse                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wnm-fanxp-frontend` | `apps/usage-metrics-dashboard` is the pattern for a separate app in the monorepo. It is a workspace package that exports `./routes` and a scoped stylesheet; the host imports it, lazy-loads it under `/:clientCode/usage-metrics/*`, and its CSS is prefixed by `scripts/build-usage-metrics-styles.cjs`. No federation, no iframe, no separate deploy |
| frontend             | Tenant home tiles are hard-coded in `features/dashboard/ui/DashboardPage.tsx` (Core Tools `:297`, Support utilities `:321`). There are no flags or permissions on the tiles                                                                                                                                                                             |
| frontend             | Auth: JWT in `localStorage.token`, axios `api` at `/fanxp/api/v1` with `Authorization` and `client: <code>` headers (`shared/api/client.ts`)                                                                                                                                                                                                            |
| frontend             | Live jobs: the AI gateway's POST-SSE parser and resume-by-polling (`shared/api/ai/aiSse.ts`, `runAiJob.ts`, `aiJobSession.ts`). This is the closest thing to following a run                                                                                                                                                                            |
| frontend             | Tenant theme and fonts in a preview canvas: `GET /themes/properties` tokens → `genCssFromJson` (`@sikit/utils`), fonts embedded as base64, all injected into a same-origin `srcdoc` iframe (`shared/ui/device-iframe/DeviceIframe.tsx`, `DeviceIframeStyles.tsx`)                                                                                       |
| frontend             | Cast: the workspace (`features/cast`), and template bindings `GET/PUT/DELETE /cast/templates/:templateId/binding` `{ hookId, pinnedWorkflowId?, inputMapping }`                                                                                                                                                                                         |
| `wnm-fanxp-backend`  | Fastify modules (`src/routes/index.ts` `routeModules`), `preHandler: [validateClientHeader, authenticate, routePermission('X:perm')]`, permissions seeded by migration (copy `20261021100000_add_ai_permissions.ts`). Tenant = `site_code` = the `client` header = dugout's tenant                                                                      |
| backend              | Template types are rows in `master_content_type` (numeric id → `json_name`). A new type is a seed row plus its mapper rows                                                                                                                                                                                                                              |
| backend              | **`workflowId` is already stamped on templates at read time** from `master_cast_template_bindings` (`castService.enrichTemplatesWithWorkflowIdsService`, `src/services/cast/index.ts:864`), on both the live and the published page schema                                                                                                              |
| backend              | Publish: `POST /publish-workflow` snapshots templates per device into `publish_templates`, writes theme CSS to S3, and invalidates CloudFront ("Publish All Changes")                                                                                                                                                                                   |
| backend              | Service-to-backend auth: `POST /ai/authorize` (JWT + `AI:use`) and the `x-ai-service-key` header                                                                                                                                                                                                                                                        |
| `fanxp-web-renderer` | `PageSchemaTemplate.workflowId` exists. Templates with one are hydrated from `/cast/api/flow/<workflowId>` (`kmp.service.ts:1116`). `dynamic_block` is dispatched in its own branch (`query-engine.tsx:417`), which is the precedent for a V2 branch                                                                                                    |
| dugout               | Agents: `section-builder` (frame-match → bind), `hook-finder`, `hook-maker`. Worker, run events on a Valkey stream with SSE resume, approvals, CLI host. Control plane `apps/api` (exports, artifacts, surfaces, runs). Studio's board, export inspector (IR, DSL, Gaps, Data & logic)                                                                  |

Gaps found on the way:
- **SSE through `/fanxp*` is buffered.** CloudFront compresses that path (`src/controllers/cast/mcp.ts:169`). The backend has no streaming, no job queue and no run model.
- **The tree is not prepared end to end.** `bind.publish` stores a plan and a data snapshot. The tree does not carry its data source, and the preview applies the plan on every request.
- **Our renderer's theme and fonts are not the tenant's.** `@fanos/tokens` compiles a Figma theme export (`token_set`), and `FONT_FACE_CSS` hard-codes two families. FanXP's tenant theme is `master_themes.tokens` through `genCssFromJson`.
- **Images are inlined.** The 69-node news grid is 497 KB because its six images are base64 `data:` URIs.

## Target shape

```
Figma plugin ──Handoff──► control plane (exports, artifacts)
                              │
admin app: apps/surface-studio (in wnm-fanxp-frontend)
   │  start run / decide / cancel / list          follow run (SSE, resumable)
   ▼                                                 ▼
wnm-fanxp-backend  `surface` module  ── run row ──► harness Postgres ◄── agents-worker (ECS)
   │  GET events  ◄──────────── Valkey stream ◄───────────────────────────┘
   │
   │  ◄── worker's write tool (approved): template.publish ──┐
   ▼                                                         │
master_templates (content_type surface_v2, bound DSL)  +  master_cast_template_bindings (hook)
   │  Layout Builder places it on a page; Publish All Changes snapshots it
   ▼
page-schema ─► fanxp-web-renderer: workflowId → /cast/api/flow → @fanos/renderer <Render>
```

**One template, prepared once.** A `surface_v2` template is the bound tree:
- refs and Repeaters are already applied;
- a `data` block names its source;
- its surface set and assets are included, with images uploaded to the tenant's S3 asset path rather than inlined.

The hook is bound through the existing `master_cast_template_bindings`, so `workflowId` arrives on the template the same way it does for every Cast-bound template today. No plan or agent is involved at serve time.

## Phases

### P0. The contract (dugout). Blocks everything else

1. A `data` block on the tree (`.scratch/data-binding/spec.md`, DSL step 1): named sources, `cast-hook` (hook id; the backend supplies `workflowId`) or `static` (previews and evals). The validator rejects a ref whose top-level name has no source.
2. `bind` publishes the **bound tree** as the result (plan applied in code). Plan and sample stay as evidence.
3. The preview renders a bound tree and fetches the hook live by `workflowId`, with `?data=` as an override. It stops applying plans.
4. Assets: images go to the tenant's asset store at publish time, and the tree keeps URLs.
5. **Spike: the tenant theme.** Render the news grid with ibl's `master_themes.tokens` and fonts instead of a `token_set`. Either `@fanos/tokens` reads FanXP tokens, or `frame-match` compiles against them. The answer decides whether a page's preview and the live site can look the same.

Done when: the dugout preview shows the news grid with live Cast data, ibl's theme and fonts, from one stored template.

### P1. Backend `surface` module (wnm-fanxp-backend)

- Migrations:
  - permission module `SURFACE_STUDIO` (`read`, `run`, `approve`, `publish`)
  - content type `surface_v2` with its mapper rows
- Run routes (JWT + `client` + permission). These are what `apps/cli` does today:
  - `POST /surface/runs` to start a run (section-builder for an export, or one agent)
  - `GET /surface/runs` and `GET /surface/runs/:id`
  - `POST /surface/runs/:id/decisions` (approve, reject, request a change)
  - `POST /surface/runs/:id/cancel`
- `GET /surface/runs/:id/events`: SSE from the run's Valkey stream, with `Last-Event-ID`, 12 s heartbeats and a polling fallback (the `runAiJob` contract). It needs its own CloudFront behavior with compression off.
- Control-plane reads, proxied with tenant auth: exports, artifacts, previews.
- `POST /surface/templates` (service key, called by the worker's approved write tool): creates or versions the `surface_v2` template and its Cast binding. Returns the template id.

### P2. The Studio app (wnm-fanxp-frontend)

- `apps/surface-studio`, a copy of the usage-metrics host contract:
  - `exports` for `./routes` and `./embed.css`
  - `RouteBaseProvider`, `HashNuqsAdapter`, its own QueryClient
  - a scoped stylesheet (`.surface-studio-scope`) built by a copy of the styles script
- Host wiring:
  - `surface-studio.routes.tsx` under `/:clientCode`
  - Vite aliases, `fs.allow` and `optimizeDeps`
  - `tsconfig.build.json` exclude, an ambient `.d.ts`, and a `<link>` in `index.html`
- A **Core Tools** tile ("Surface Studio") next to Layout Builder and CMS. This is a core tool, not a support utility.
- A permission check with `useModuleAccessCheck('SURFACE_STUDIO')`.
- The canvas reuses the host's tenant-theme pipeline (theme tokens → CSS, embedded fonts, a `srcdoc` iframe) and renders `@fanos/renderer`'s client components inside it.
- Screens: see UI/UX below.

### P3. Layout Builder knows the V2 template

- `surface_v2` appears in the template list and can be placed on a page.
- `FanxpTemplateRenderer` gets a branch that renders the tree with `@fanos/renderer` and **live** hook data. Today it uses placeholder data per content type.
- Publish All Changes carries it. `buildTemplateInsert` empties `data.items` but must keep the tree.

### P4. The site renderer (fanxp-web-renderer)

- A `surface_v2` branch next to `dynamic_block` in `query-engine.tsx`.
- Add `surface_v2` to `NON_KMP_CONTENT_TYPES`.
- Hydrate through the existing `workflowId` path, then `<Render tree data={{ [source]: template.data }}>` with the tenant theme already on the page.

### P5. Production

- Temporal replaces lease claiming (H7).
- agents-worker on ECS.
- Valkey eviction policy for run streams (`noeviction` or its own cluster).
- The Figma plugin's production origin and how it authenticates.
- Re-record frame-match baselines on Linux.

## UI/UX directions

The design is not final. These are the directions to design against.

**1. It is a review tool, not a chat.** The agent's work is shown as evidence for a decision: what it matched, what it bound, what is still off, what it costs. The canvas is the centre of every screen. Logs, DSL and IR are an engineer's drawer, not the main view.

**2. Four nouns, in this order.** _Send_ (a Figma frame arrived) → _Run_ (the agents working on it) → _Template_ (a section, versioned, with its data source) → _Page_ (where it is placed, in Layout Builder). Navigation, URLs and empty states all use these four words. Not "artifact", "export", "dsl_tree" or "binding plan".

**3. One studio layout for a Handoff:**

```
┌ Surface Studio · ibl ───────────────────── [Needs you 2] [Desktop|Tablet|Mobile] ┐
│ Handoffs        │                 CANVAS                     │ Inspector            │
│ ● News grid  │  ┌───────────────────────────────────────┐ │ ▸ Run   (timeline)   │
│   running    │  │  rendered section, tenant theme+fonts │ │ ▸ Data  (bindings)   │
│ ○ Fixtures   │  │  [Figma ◐ Render] slider · score 94   │ │ ▸ Issues (3)         │
│   needs you  │  └───────────────────────────────────────┘ │ ▸ Advanced (DSL, IR) │
│ ○ Squad row  │  Data: [Live ▾] Figma copy · Live · Empty · Long text            │
│   published  │                                            │ [Approve] [Change…]  │
└──────────────┴────────────────────────────────────────────┴──────────────────────┘
```

- **Left: the queue.** Handoffs with one status each: running, needs you, ready, published, failed. Filter by status and Figma file.
- **Centre: the canvas.**
  - The section in the tenant's own theme and fonts, at a device width.
  - **Figma vs render** as an onion-skin slider and a diff overlay, with the fidelity score. Mismatches are pinned on the canvas, not listed elsewhere.
  - A **data scenario switch**: Figma copy, live hook data, empty list, long text, each variant's state. Binding problems show up here before anyone reads a field list.
- **Right: the inspector.**
  - **Run:** a step timeline grouped by stage (Match → Bind → Data → Publish). Child runs (frame-match, bind, hook-finder, hook-maker) are nested and collapsible. Each has its time and cost. The model's text stream is collapsed by default.
  - **Data:** select a node on the canvas to see its ref (`{article.headline}`), the sample value and the hook it comes from. Fields the hook returns that nothing reads are listed too.
  - **Issues:** what code measured (drift, unresolved refs, layout questions the frame could not answer). Each issue links to its node on the canvas.

**4. Approvals are first-class.**
- A **Needs you** inbox across all Handoffs: approve `page.build`, approve a hook build, answer a layout question (`frame.layout`).
- Each approval shows what code measured, never the model's account of it. It offers the same three verbs as the CLI: **Approve**, **Reject**, **Request a change** (free text, sent back to the run).
- One click from a notification to the canvas with the thing in question selected.

**5. Live and reloadable.** A run can last 20 to 40 minutes. The page reattaches after a reload or a lost connection (`Last-Event-ID`), shows "reconnecting" instead of an error, and the run keeps going if the tab is closed.

**6. Templates library.**
- Every published `surface_v2` template, with: thumbnail, data source (hook name, last fetch OK or failed), version history, and the pages that use it ("Used on Home, Team").
- Actions: open in Layout Builder, rerun from a new Handoff, roll back a version.

**7. Home of the tool (empty and steady state).**
- **Setup checks, each with its fix:**
  - Figma plugin connected
  - Cast connected (the tenant's OAuth grant)
  - Theme synced (the tenant theme the canvas uses)
  - Hooks available
- Then: Needs you, Recent Handoffs, Templates.
- The empty state is one instruction: "Press Handoff in the Figma plugin", with a link to install it.

**8. Look and feel.**
- Same visual language as the FanXP admin: the tile colour groups and type scale from the host's `tailwind.config.js`, and lucide icons.
- Built like usage-metrics: its own scoped Tailwind and shadcn, so the canvas and the admin chrome never share CSS.
- Neutral chrome (greys, one accent) so the tenant's colours on the canvas are the only colour on screen.

**Not in v1:** editing the DSL by hand, a chat box with the agent, multi-section pages, editing a hook inside Studio (link to the Cast workspace instead).

## Open questions

1. ~~Where the control plane runs in dev and prod.~~ Decided: nowhere. Its data moves to the FanXP DB and S3,
   and agents reach it through Surface MCP (`docs/adr/0027-two-databases.md`). Still open there: an audit of
   its `runs` module.
2. **How `wnm-fanxp-frontend` and `fanxp-web-renderer` get `@fanos/renderer`, `@fanos/dsl` and `@fanos/tokens`**, which live in dugout today. Both need the same build.
3. **Where the tree sits in a template.**
   - Inline in the template's JSONB: carried by the published snapshot and the page-schema cache. Size matters, so images move out first.
   - A reference, like `dynamic_block`'s `Block-Id`: one more fetch per section.
4. **The theme vocabulary** (P0.5): FanXP tokens into `@fanos/tokens`, or the reverse.
5. **The stream path:** a CloudFront behavior for `/fanxp/api/v1/surface/runs/*/events` with compression off, or polling only for v1.
6. **The permission:** who gets `SURFACE_STUDIO`, and is it super-admin only at first?
7. **The Figma plugin in production:** its allowed origin (today `localhost:3000`), and how a Handoff is tied to a user and tenant.
