# SCRE in FanXP: one section renderer, the tenant's own theme

A section dugout's agents publish (a flat DSL tree, its surface set, a binding plan, its data) is drawn by
one renderer everywhere: Surface Studio's canvas and, later, real FanXP pages. That renderer is SCRE, the
Surface Core Render Engine: `@sikit/scre` in fanxp-web-renderer, moved there from dugout's
`packages/renderer`. It draws with the tenant's own theme CSS, the CSS every FanXP page already loads,
never a dugout token set.

SCRE is added beside what exists, never in place of it. The page renderer (`@sikit/renderer`) keeps
drawing every page as it does today, and dugout's `packages/renderer` and the `apps/web` preview on :3000
stay until a person decides otherwise (ticket 06 is on hold).

## Decisions

- **Move, not copy** (2026-11-06). fanxp-web-renderer holds the only renderer. dugout's fidelity harness
  will import the `@sikit` package, so the page it measures is the page that ships. Until ticket 06,
  dugout's `packages/renderer` still exists and still draws with its own `--fos-*` theme: the two are
  not yet one.
- **Name: `@sikit/scre`** (2026-11-06), SCRE for Surface Core Render Engine, at `packages/scre` in
  fanxp-web-renderer; its component is `<SurfaceSection>`, its template content type `surface_section`.
  It was `@sikit/sdui-renderer`, too close to `@sikit/renderer` (the page renderer),
  `@sikit/block-renderer` and the `wnm-sdui-render-engine` repo. The leftover
  `packages/molecules/block-rendererv2` (only `dist/` and `node_modules`, its source removed in `ac80a661`)
  is unrelated and can be deleted.
- **Tenant theme, no theme input.** A token ref names the variable `genCssFromJson` (`@sikit/utils`)
  already declares (`packages/scre/src/tokens.ts`):

  | ref | tenant CSS |
  |---|---|
  | `color.x` | `var(--x-hex)`; with an alpha `hsl(var(--x) / a)` (the tenant's `--x` is an HSL triple) |
  | `space.x` | `var(--spacing_x)` |
  | `radius.x` | `var(--radius_x)` |
  | `opacity.x` | `var(--opacity_x)` |
  | `gradient.x` | `var(--gradient_x_gradient)` |
  | `type.x` | our class `.fos-type-x` from `--x-font-size`, `-font-family`, `-font-weight`, `-line-height`, `-letter-spacing` |
  | `shadow.x` | `--fos-shadow-x`, read from the tenant's `.x { box-shadow }` class (it has no variable) |
  | `duration.*`, `easing.*` | the built-in scale, inline (no theme carries motion) |
  | `surface.*`, `asset.*` | the section's own surface set, written as `.fos-surface-*` in tenant names |

  `prepareSection({ tree, surfaces, plan, tenantCss })` returns the section CSS and `missing`: every ref
  the tenant does not declare, which hosts show instead of drawing nothing quietly.
- **Studio draws in an iframe** at the section's designed width, scaled to fit. The tenant CSS sets
  global classes and `:root` variables that would restyle Studio, and its breakpoints follow the
  viewport, which in the frame is the section's width, as on the page.
- **Data: Snapshot and Live, behind a switch.** Snapshot is the `sample_data` artifact the run bound
  (already unwrapped by `fromCastFlow`). Live runs the published Cast hook server side
  (`castService.runWorkflowByIdService`) and returns `{ [as]: { castFlow: output } }`, unwrapped the same
  way by `sectionData`.
- **The DSL is copied, not moved.** The renderer needs ~3.6k lines of `@fanos/dsl` (flat tree, values,
  binding, clocks, plans, Cast envelope). They are copied verbatim into `packages/scre/src/dsl/`
  with only the `@fanos/tokens` import pointed at `../tokens.ts`. dugout's `packages/dsl` stays the source.
  Ticket 07 keeps them from drifting.
- **The whole package is `"use client"`**, as `@sikit/renderer` is. Only the carousel and clocks use
  hooks; everything else is plain markup and draws the same on a server.
- **Nothing is deleted** (2026-11-06). `@sikit/renderer` only gains: a `surface_section` template it
  passes over safely. dugout's `packages/renderer` and `apps/web` stay; ticket 06's deletions wait for a
  person's say.
- **A section on a page is a template** (2026-11-06, ticket 02). A page holds templates; a section placed
  on one is a template too, content type 24 `Surface Section` (`surface_section`), its DSL in a new
  `surface_dsl` JSONB column on `master_templates`, carried through every save as `css` is. The column
  holds `{ digest, tree, plan, surfaces, source, … }`: a copy, so the template is pinned to the digest it
  was added with and never changes under a page. Republishing means adding again. The page builder never
  reads the column (it can be megabytes); it reads `data.surface_section`, a summary. `publish_templates`
  gets the column with ticket 03, when pages draw a section.
- **"Add to page" is its own step** (2026-11-06). Approving a run builds the preview only. In Studio, a
  person presses Add to page on the canvas and picks a page; the backend adds the template to that page.
- **For now the preview is only in Studio** (2026-11-06). The page builder shows a `surface_section`
  template as a placeholder card, as it does a plugin or an unset dynamic block, with a link that opens
  it in Studio. Drawing it on the page (ticket 03) comes later.
- **Slice order** (agreed): Studio canvas (slice 1, done), then the section as a template (slice 2,
  below), then drawing it on the page.

## Slice 1: done (Studio canvas)

Nothing is committed. Three repos, each on its own branch:

| Repo | Branch | What |
|---|---|---|
| fanxp-web-renderer, worktree `../fanxp-web-renderer-sdui` | `feat/scre` (from `development` `4e90fb96`) | new `packages/scre`; `pnpm-lock.yaml` |
| wnm-fanxp-backend-surface-auth | `feat/surface-runs-host` | `GET /surface/runs/:id/section` and `/section/live`: `src/services/surface-section/`, `src/interfaces/surface-section.ts`, two handlers in `controllers/surface-run`, routes in `routes/surface-run`, errors `SURF_28`–`SURF_30`, `'surface-section'` in `types/index.ts` `tracingModule`, `FANOS_API_URL`/`FANOS_API_KEY` in `.env.example`, `tests/services/surface-section.test.ts` |
| wnm-fanxp-frontend | `feat/surface-live-queue` | Studio: `features/queue/ui/section-canvas.tsx`, `entities/surface/queries/use-section-query.ts`, `use-tenant-theme.ts`, transport/API/mock/schema additions, `queue-page.tsx`; `apps/fanxp/vite.config.ts` and Studio's `vite.config.ts`/`vitest.config.ts` allow the linked package's folder |

The backend and frontend branches already carried other uncommitted work: review those diffs by file.

### Where the section comes from

`sectionRefs` (backend) reads the artifact ids off the run's output (`section-builder` reports
`treeArtifactId`, `planArtifactId`, `dataArtifactId`, `previewUrl`), else off its child runs
(`frame-match`, `data-bind`). The surface set id is only in `previewUrl` (`?surfaces=`). The Cast source
(`hookId`, `workflowId`, `input`, `as`) is in the data artifact's `meta.data`. Artifacts are read from
dugout's control plane (`FANOS_API_URL`, default `http://localhost:4100`), which is retiring (ADR 0027).

### Checked

- Package: dugout's 224 browser-free renderer tests, ported (only var names, fixture and import paths
  changed), plus 11 on the real "IN THE FRAME" section with Southern Brave's theme: 235 pass; `tsc` and
  `tsup` build clean; Swiper is its own chunk.
- The real section drawn with the package and `genCssFromJson` against the old :3000 preview at 1368px:
  154 of 943,920 pixels differ (0.016%); `missing: []`, `drift: []`, 12 bound.
- Backend: `getSection` in-process against the real harness DB and control plane for run
  `bce94e29-59f5-4060-b200-374737ea6598` (tenant `sb`) returns 70 nodes, 4 surfaces, the plan, the data
  and the Cast source; as tenant `demo-cricket` it is "Surface run not found". 35 jest tests pass.
- Studio: 341 tests pass (one draws a section into the frame and checks the tenant CSS stays out of
  Studio's document); `tsc -b` clean; :5555 serves the canvas and the linked package from source.

### Not checked

- The canvas in a signed-in browser at :5555 (ticket 08).
- Live data end to end. `https://sb.dev-fanxp.sportz.io/cast/api/flow/7e960670-…` 404s: the hook seems to
  exist only in the local Cast at :4000.

## How to run it

```sh
# renderer package
cd ../fanxp-web-renderer-sdui/packages/scre
pnpm test && pnpm build

# backend (nodemon reloads): the route
GET /fanxp/api/v1/surface/runs/<runId>/section        # admin JWT + client header
GET /fanxp/api/v1/surface/runs/<runId>/section/live

# Studio: http://localhost:5555/#/<client>/surface-studio/queue/<sendId>
```

## Things that bite

- **The package is linked, not installed.** Studio's `package.json` has
  `"@sikit/scre": "link:../../../fanxp-web-renderer-sdui/packages/scre"`; Vite resolves its
  `development` export to `src/`, and both Vite configs add the real folder to `server.fs.allow`
  (`linkedPackageDir`), else Vite answers "Denied ID". Ticket 01 replaces the link with a version.
- **`@sikit/utils` is not in Studio's `package.json`.** `use-tenant-theme.ts` imports it; it resolves
  because the host's copy is hoisted. Adding it failed: the CodeArtifact token had expired
  (`pnpm co:login`).
- **dugout pins the public registry** (`.npmrc`, because the global CodeArtifact token expires). Consuming
  a `@sikit` package from dugout (ticket 06) needs a way around that.
- **Tenant breakpoints are 768/1200; the renderer's own CSS uses 768/1280.** Only `Resp` props read the
  renderer's; type follows the tenant's. Harmless for desktop-only DSLs, worth settling before tablet.
- **The tree carries its images as base64**: 5.7 of this section's 5.8 MB. Fine in Studio, not in a page
  (ticket 04).
- **The surface set can be another tenant's.** frame-match run `ec5e237e` (tenant `sb`) linked surface set
  `f82cafe2`, written by a `demo-cricket` `card-match` run on 1 Nov. It covers this tree's three surfaces
  by luck (ticket 05).

## Slice 2: the section as a template

Goal: a person sees a run's section in Studio, adds it to a page from there, and the page builder shows
it in place, as a placeholder that opens Studio. Pages do not draw it yet, and nothing that draws a page
today changes.

| # | Ticket | Repo | State |
|---|---|---|---|
| 09 | `09-rename-to-scre.md`: `@sikit/sdui-renderer` becomes `@sikit/scre` | renderer, frontend, backend | done |
| 10 | `10-surface-section-template-column.md`: content type `Surface Section` and the `surface_dsl` column, carried like `css` | backend | done, not migrated |
| 11 | `11-add-to-page.md`: `POST /surface/runs/:id/section/add-to-page`, the pinned DSL as a template on a page | backend | done |
| 12 | `12-page-builder-placeholder.md`: the placeholder card and "Preview in Surface Studio" | frontend (fanxp) | done |
| 13 | `13-studio-add-to-page.md`: Add to page on the canvas, with a page picker | frontend (Studio) | done |
| 14 | `14-page-renderer-passes-over.md`: `@sikit/renderer` skips `surface_section` safely | renderer | done |
| 15 | `15-studio-preview-room.md`: the preview in the centre, every Send a thread at the right (Execution, Plan, Data, …), Focus, zoom | frontend (Studio) | done |

Nothing is committed, and nothing has been tried end to end: the migration has not run (the backend's
database looks like the shared dev one), and no one has pressed Add to page in a signed-in Studio. That
check belongs with ticket 08.

## Later: the page draws it

1. `01-publish-package.md`: publish `@sikit/scre`, replace the link
2. `02-where-a-section-lives.md`: answered (see Decisions)
3. `03-surface-section-template.md`: `content_type: "surface_section"` drawn by `@sikit/renderer`
4. `04-images-out-of-the-tree.md`: upload pictures, reference them by URL. Matters more now: every
   template version copies `surface_dsl`, and the tree is 5.8 MB, 5.7 of it base64 pictures
5. `05-surfaces-belong-to-the-section.md`: the run's own surface set, or surfaces written into nodes
6. `06-dugout-on-the-sikit-renderer.md`: the harness on the package. On hold: deletes nothing until a
   person says so
7. `07-dsl-copy-drift.md`: keep the copied DSL equal to dugout's
8. `08-verify-canvas-signed-in.md`: the canvas and Live in a real session
