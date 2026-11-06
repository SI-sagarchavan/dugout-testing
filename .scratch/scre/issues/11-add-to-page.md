# 11 · Add to page (backend)

Status: done (2026-11-06)
Type: task
Blocked by: 10

## What

`POST /surface/runs/:id/section/add-to-page` `{ pageLayoutId, devices = ['desktop'] }`, needs `Surface:send`
and `Page:Update`. `services/surface-section/add-to-page.ts`:

1. Reads the run's section as `GET …/section` does (control plane, by the run's artifact ids).
2. Digest: sha256 over `{ tree, plan, surfaces }` with keys sorted. The data is not part of it (it is the
   hook's, live), so it is not copied either.
3. Builds the template: content type looked up by `json_name` (`surface_section`), name
   `<Handoff frame name> · <digest[:7]>`, header and footer off, `data.surface_section` for the page
   builder, `surface_dsl: { schema: 1, digest, tree, plan, surfaces, source, runId, handoffId, addedAt }`.
4. Adds it with `updatePageLayoutService(…, { templates: { add: [template] } })`: the page builder's own
   path, so page versioning and each device's order work as they do there.

Errors: `SURF_31` page not the client's (404), `SURF_32` that digest is already on the page (409),
`SURF_33` content type not migrated (503).

## Checked

- `tests/services/surface-section.add-to-page.test.ts` (8) and `tests/routes/surface-section.routes.test.ts`
  (4: permissions, default device, body validation). Not run against a database.
