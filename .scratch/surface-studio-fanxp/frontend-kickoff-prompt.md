# Kickoff prompt: Surface Studio app in wnm-fanxp-frontend

Paste everything below the line into a new Claude Code session started in
`/Users/sagarchavan/si/build/wnm-fanxp-frontend`.

---

You are building the first slice of **Surface Studio**, a new admin app inside this monorepo. It is
the review and control tool for an AI pipeline that turns Figma frames into pages: Sends arrive from
a Figma plugin, agent runs execute, a person reviews and approves the result, and an approved page
becomes a FanXP template. The route is `https://dev-fanxp.sportz.io/#/<clientCode>/surface-studio`,
for example `/#/ibl/surface-studio`, launched from the tenant home (the Core Tools section of
`apps/fanxp/src/features/dashboard/ui/DashboardPage.tsx`).

## Read first, in this order

1. `.ai-rules/README.md`, then every file it lists. Branch names must be `feat/...`. Commit types are
   only `feat`, `fix` or `bugfix`. Do not bypass hooks. Do not push.
2. `/Users/sagarchavan/si/build/dugout/.scratch/surface-studio-fanxp/spec.md`: the full plan. You are
   building **P2** (the app). Read "Target shape", "P2" and "UI/UX directions".
3. `/Users/sagarchavan/si/build/dugout/.scratch/surface-studio-fanxp/send-flow.md`: how a Send becomes
   a run and then a template. It tells you which states and nouns the UI must show.
4. The reference app, `apps/usage-metrics-dashboard`, and how `apps/fanxp` mounts it. Study these
   files before writing anything:
   - `apps/usage-metrics-dashboard/package.json` (the `exports` map: `.`, `./routes`, `./styles.css`, `./embed.css`)
   - `apps/usage-metrics-dashboard/src/host/*` (routes, route base, hash nuqs adapter, app link, styles entry, public API types)
   - `apps/usage-metrics-dashboard/vite.config.ts`, `vite.config.styles.ts`, `components.json`
   - `apps/usage-metrics-dashboard/src/index.css` (the Tailwind 4 `@theme inline` block and the `:root` and `.dark` tokens)
   - `scripts/build-usage-metrics-styles.cjs` (scopes the compiled CSS under `.usage-metrics-scope`)
   - in `apps/fanxp`: `vite.config.ts` (aliases for the sub-app), `index.html` (the `<link>` for the embed CSS),
     `src/app/routes/usage-metrics.routes.tsx`, `usage-metrics-wrappers.tsx`, `src/app/router.tsx`,
     `src/types/usage-metrics-dashboard.d.ts`, and the root `package.json` scripts (`postinstall`, `build`, `dev:usage-metrics`)

## Why the app is separate and scoped

The host (`apps/fanxp`) is Tailwind 3. The sub-apps are Tailwind 4 plus shadcn (`radix-nova` style).
The same utility class names would clash, so the sub-app's CSS is compiled on its own, its `@layer`
blocks and `@property` rules are stripped, every selector is prefixed with a scope class, and the
host loads the result with a `<link>`. Do the same for this app with the scope class
`.surface-studio-scope`. Do not import the sub-app's source CSS into the host's PostCSS pipeline.

## Decision already made: copy, do not extract yet

`packages/` is empty (only `.gitkeep`), so there is no shared UI or theme package today. Copy what
you need from `apps/usage-metrics-dashboard` into the new app:

- `src/components/ui/*` (shadcn primitives: button, card, badge, tabs, sheet, dialog, dropdown-menu,
  table, data-table, skeleton, sonner, tooltip, scroll-area, separator, sidebar, etc.). Copy only
  what the slice uses.
- `src/lib/utils.ts`, `toast.ts`, `query-client.ts`, `embed-scope.ts`, `api-base-url.ts`
- `src/hooks/use-theme.ts`, `use-mobile.ts`
- the `:root` / `.dark` tokens and `@theme inline` block from `index.css`

Do not modify `apps/usage-metrics-dashboard`. Extracting `@fanxp/ui` and `@fanxp/theme` into
`packages/*` is a later, separate change once two apps use the same files. Leave a short note in the
new app's README listing what was copied and from where, so that change is easy.

## Stack

Use the same versions as `usage-metrics-dashboard`: React 19 with the React Compiler babel preset,
Vite 8, Tailwind 4, TypeScript 6, `react-router-dom` 6, TanStack Query 5, TanStack Table 8, `nuqs`
with the hash adapter, Zustand 5, Zod 4, `react-hook-form`, `sonner`, `lucide-react`, `oxlint`.
Package name `@fanxp/surface-studio`, dev port `5175`. The app is a Vite SPA embedded in the host
through the `./routes` export, like usage-metrics. It must also run standalone with `pnpm dev:surface-studio`.

Two theming layers, kept apart:

- **Chrome** (nav, lists, inspector): neutral, the usage-metrics tokens, light and dark.
- **Canvas** (the centre preview of a page): later slice. It will use the tenant's own theme and
  fonts, the way `apps/fanxp/src/shared/lib/hooks/useThemeCSS.ts` and the layout builder's
  `DeviceIframe` do. Do not build it now, but keep the chrome free of tenant colours so the two never mix.

## Slice 1: build this

1. **Scaffold** `apps/surface-studio`, mirroring usage-metrics: `package.json` with the same `exports`
   shape, tsconfigs, `vite.config.ts`, `vite.config.styles.ts`, `components.json`, `src/host/*`,
   `src/app/*`, `src/index.css`.
2. **Wire it into the monorepo and host**: a root `dev:surface-studio` script;
   `scripts/build-surface-studio-styles.cjs` (copy the usage-metrics script, change the scope, source
   and destination) and add it to root `build` and `postinstall`; the vite aliases in
   `apps/fanxp/vite.config.ts`; the `<link href="/surface-studio-embed.css">` in `apps/fanxp/index.html`;
   `src/types/surface-studio.d.ts`; `surface-studio.routes.tsx` and `surface-studio-wrappers.tsx` in
   `apps/fanxp/src/app/routes/`, registered in `router.tsx` as `surface-studio/*` inside `PrivateRoute`.
3. **Launch tile**: add a Surface Studio tile to Core Tools in `DashboardPage.tsx`, in the same style as
   its neighbours. Gate it behind a flag in the new app's `lib/feature-flags.ts` (default on in dev
   only) because the permission is not decided yet (spec open question 6). Do not invent a backend permission.
4. **Shell**: a layout with a left nav (Queue, Needs you, Templates, Setup) and a header, using the
   `sidebar` primitive. Scope class on the root element, `h-[calc(100vh-0px)]` sizing as in usage-metrics.
5. **Queue page** (the main screen), a three-pane layout from the spec's UI section:
   - left: the queue of Sends, one status each (running, needs you, ready, published, failed), with filters;
   - centre: a placeholder panel where the canvas will go ("Preview comes in the next slice");
   - right: an inspector with tabs Run, Data, Issues, Advanced, showing a run's step timeline grouped
     as Match, Bind, Data, Publish, with child runs nested and collapsible.
     Selection lives in the URL (`/surface-studio/queue/:sendId`) so a reload keeps it.
6. **Data layer with a mock adapter**: the backend `surface` module does not exist yet. Define Zod
   schemas and typed TanStack Query hooks for `Send`, `Run`, `RunStep` and `Approval`, matching the
   planned routes in the spec (`GET /surface/runs`, `GET /surface/runs/:id`, decisions, cancel). Back
   them with an in-memory mock adapter that returns realistic fixtures, switchable to the real axios
   client (`/fanxp/api/v1`, `client` header, JWT in `localStorage.token`, as in the host) by one
   environment flag. Soft-fail response validation per `.ai-rules/07-zod-validation.md`.
7. **Needs you inbox**: a list of runs waiting on a person with Approve, Reject and Request a change
   actions against the mock adapter. No live streaming yet.

## Out of scope for this slice

The canvas and tenant theme, the Figma-vs-render slider, live run events (SSE), the templates library
internals, the Setup checks beyond a static page, any backend or plugin change, any change to
`apps/usage-metrics-dashboard`, the `packages/*` extraction.

## Working rules

- Follow FSD and the other `.ai-rules` files. Where usage-metrics deliberately differs from the host
  (shadcn and `cn` instead of `tailwind-variants`), follow usage-metrics inside the new app and say so
  in its README.
- Tests: write them with the code (`.ai-rules/08-testing.md`). Cover the mock adapter, the Zod schemas,
  the URL-driven selection and the Needs you actions.
- Verify before you say it is done: `pnpm install`, `pnpm build:surface-studio-styles`, `pnpm typecheck`,
  the app's own `pnpm --filter @fanxp/surface-studio typecheck` and `lint`, the relevant tests, then
  run `pnpm dev` and open `/#/ibl/surface-studio` to confirm the tile, the route, scoped styles and
  that the host's other pages are unchanged. Report anything you could not check.
- Create a branch `feat/surface-studio-shell` from the current state. Make small commits. Do not push.

When the slice works, stop and summarise what you built, what you copied from usage-metrics, and what
you left for later. Do not start the canvas.
