# 03 · content_type "surface_section" in @sikit/renderer

Status: needs-triage
Type: task
Blocked by: 10, 11 (02 is answered: the DSL is the template's `surface_dsl`, so no fetch by ref is needed)

## What

The old renderer draws the page; a v2 section is one template in it. Follow `dynamic_block` exactly:

- `packages/renderer/src/page/query-engine.tsx`: where `template.content_type === "dynamic_block"` picks
  `DynamicBlockTemplateRenderer` (two places: `renderWrapPlugin` around line 281, the core content around
  line 419), add `"surface_section"` → `SurfaceSectionTemplateRenderer`.
- `packages/renderer/src/page/surface-section-template-renderer.tsx`: modelled on
  `dynamic-block-template-renderer.tsx`: same shell (`SduiTemplateProvider`, `Box`, composition
  header/footer, `ErrorBoundary`, `MoleculeAnalyticsWrapper`), body
  `<SurfaceSection section={prepareSection(…)} data={…} />` loaded with `next/dynamic` so pages without one
  do not ship it.
- Data: the template's Cast workflow output, which `attachWorkflowOutput` (`page/services/kmp.service.ts`)
  already fetches for any `workflowId`-bound template. Pass it as `{ [as]: { castFlow: output } }` through
  `sectionData`, the same unwrapping Studio's Live mode uses.
- Theme: nothing to add. The page already carries the tenant CSS (`page/theme-css.ts` `buildThemeCss`).
  Import `@sikit/scre/styles.css` once (like `carousel-listing.css`), and do not pass `tenantCss`
  to `prepareSection` on the page (it only feeds `missing` and shadows; shadows need it, so decide whether
  the page passes the theme CSS string it already built).
- Hydration: the package is `"use client"`; check the carousel mounts once on a hydrated page and that
  SSR markup equals the client's (clocks use a fixed `now` on the server).

## Done when

- A page with one `surface_section` template renders the "IN THE FRAME" section with live Cast data, beside
  ordinary templates, in `apps/web` of fanxp-web-renderer.
- A pixel check against Studio's canvas for the same section and data.
- Pages without one do not load the package (bundle check).

## Since slice 2 (2026-11-06)

- The section is the template's own `surface_dsl` (ticket 10), not a ref to fetch: the page schema
  (`services/page-schema`) and publish (`publish_templates`, `getTemplatesForPageLayoutById`, which drops
  it today) must start carrying it, and ticket 04 should land first (5.7 MB of base64 per template).
- `query-engine.tsx` already has the branch (ticket 14): replace its `return null` with the renderer.
- The page builder's placeholder (ticket 12) can then draw the section too.
