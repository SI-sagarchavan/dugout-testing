# 10 · Content type "Surface Section" and the surface_dsl column

Status: done, not migrated (2026-11-06)
Type: task
Blocked by: none

## What

wnm-fanxp-backend, branch `feat/surface-runs-host`:

- `migrations/master/scripts/20261106120000_add_surface_section_template.ts`: content type 24,
  `Surface Section` (`surface_section`), mapped to no layout category (the Add Template drawer does not
  offer it), and `surface_dsl JSONB` on `master_templates` only (publish does not carry it yet).
- Carried like `css` (`13008c3e`), so no save loses it: `services/pagelayout` (create, every new version
  and in-place update; the page builder never sends it, so the existing one is kept), `models/template`
  (create, new version, revert).
- Left out of `getTemplatesForPageLayoutById` (`delete templateResult.surface_dsl`): the page builder
  and publish read templates through it, and neither needs megabytes of DSL. The builder reads
  `data.surface_section` (digest, run, Handoff, name, workflow id, when).

## Not done

- The migration has not run anywhere: the backend's `.env` points at `localhost:9991/fanxp_dev`, which
  looks like a tunnel to the shared dev database.
- `publish_templates` has no `surface_dsl`; ticket 03 adds it when pages draw sections.

## Checked

- Two new tests in `tests/services/pagelayout.services.test.ts` (written as JSON; carried into a new
  version the page builder sent without it). Whole backend suite: 6196 pass, `tsc` clean.
