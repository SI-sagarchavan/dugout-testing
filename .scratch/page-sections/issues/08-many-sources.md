# 08 · One data map, several sources

Status: done for dugout, Studio and the backend (2026-11-09); open: the page renderer draws no surface_section yet; when it does, it fetches every `surface_dsl.sources` flow (SCRE two-source test with it)
Type: task
Blocked by: none

## What

The bag is already keyed by source name (`sourceBag`: `{ [as]: { castFlow: sample } }`), so one plan
can read `fixtures.castFlow…` and `squad.castFlow…`. What holds one source:

1. **bind's state**: `source` becomes `sources: Record<as, Source>`; `bind.source` adds or replaces
   the one with that `as`; the bag is every source's.
2. **bind.publish's meta**: `data` becomes a list of `{ kind: "cast-hook", hookId, workflowId,
   input, as }` (a `dataset` stays one entry). Read the old single object as a list of one.
3. **Studio** (`wnm-fanxp-frontend` `apps/surface-studio/src/shared-validation/surface.schema.ts`):
   `RunDataSchema.source` becomes `sources[]` (accept the old shape), and the inspector's Data tab
   (`features/queue/ui/inspector-data-tab.tsx`) lists each source with its bindings. The backend
   that builds `RunData` (`wnm-fanxp-backend`) follows.
4. **SCRE** (`fanxp-web-renderer-sdui/packages/scre/src/dsl/`): check `applyBindingPlan` over a bag
   with two top-level keys and two lists; port any change to `bind.ts` by hand (memory: SCRE's DSL
   copy).

## Done when

- A data-bind test: two `bind.source` calls, one plan reading both, `bind.try` clean, published meta
  with two sources.
- Studio shows a preview with two sources; SCRE renders it (a two-key bag test there).

## Pointers

- `agents/data-bind/src/tools.ts` (`Source`, `sourceBag` ~728, `bind.source` ~829, `bind.publish` ~998)

## Open: the backend (found 2026-11-09, after 09)

The dugout side now always writes the data artifact's `meta.data` as a **list**, even with a single
source (`bind.publish`: `chosen.map(...)`; section-builder the same). `wnm-fanxp-backend`
(`merge/surface-all`, worktree `wnm-fanxp-backend-surface-auth`) reads one object:
`src/services/surface-section/index.ts` `sourceOf` returns null unless `meta.data.kind === "cast-hook"`.
So **every section published since this ticket, one source or two, gets `source: null`**:

- `GET /surface/runs/:id/section` sends no source, so Studio's Data tab has no source card and the
  canvas can't go live (`canGoLive` needs `source.workflowId`);
- `GET /surface/runs/:id/section/live` fails: "Surface section has no live data";
- add to page (`add-to-page.ts`) links no Cast hook to the template (`upsertBindingService` is
  skipped), so a page's data call finds no workflow for it.

Seen on Team: artifact `782cf291-…` has `data: [fixtures, squad]`.

To do, in the backend:

1. `sourceOf` → `sourcesOf`: read a list or one object (old artifacts), and send `sources[]` on the
   section, with `source` kept as the first that has a `workflowId` (what Studio's `SectionSchema`
   already expects).
2. `/section/live`: run every source's workflow (in parallel), answer
   `{ [as]: { castFlow } }` for each, and say which failed.
3. Add to page: link each source's hook to the template. Check first whether a Cast binding can
   hold several hooks for one template (`upsertBindingService` takes one hookId); if it can't, this
   needs a Cast change or a per-source binding, and that's a decision, not a guess.
4. `ISurfaceDsl.source` → `sources` (keep `source`) so SCRE reads every one.

Until 1 lands, a stopgap on the dugout side would keep single-source sections working: write one
object when there's one source and a list only when there are several.

## Backend done (2026-11-09)

Decision: **the page fetches each source itself.** Cast binds one hook per template, so the
template's binding names the first published source, and the section's page copy lists them all.

- `wnm-fanxp-backend` (worktree `wnm-fanxp-backend-surface-auth`, `merge/surface-all`, uncommitted):
  - `src/services/surface-section/index.ts`: `sourcesOf` reads a list or one object (older
    artifacts); `primaryOf` is the first with a `workflowId`. `getSection` sends `sources[]` and
    `source`. `getLiveData` runs every published source at once, answers `{ [as]: { castFlow } }`
    for each that ran, with `sources` and `failed` (never published, or didn't answer); no live
    data only when none ran.
  - `src/services/surface-section/add-to-page.ts`: `surface_dsl.sources`; the binding stays one,
    the primary.
  - `src/interfaces/surface-section.ts`: `sources` on the section, the live answer and the DSL.
  - Tests: 31 pass (`tests/services/surface-section*.test.ts`, the routes test). Checked against
    the real Team run (`bf0b30f6`): `getSection` returns both sources.
- Studio (`wnm-fanxp-frontend`, `feat/surface-merge-all`): `SectionLiveSchema` takes `sources` and
  `failed`. The live canvas keeps the saved data for a slot whose hook didn't answer
  (`section-canvas.tsx`), so only that slot isn't live. Studio's schema tests pass (31).
- The dugout stopgap (one object for one source) isn't needed any more.

Still open: `fanxp-web-renderer-sdui` draws no `surface_section` yet (`page/constants/mappers.ts`:
"Pages do not draw one yet"). When it does, it reads `surface_dsl.sources` and fetches each flow.
SCRE's `section.ts` already reads a bag with several `{ [as]: { castFlow } }` keys.
