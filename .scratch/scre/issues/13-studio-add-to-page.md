# 13 · Add to page in Studio

Status: done (2026-11-06)
Type: task
Blocked by: 11

## What

wnm-fanxp-frontend `apps/surface-studio`:

- Transport and API: `listPages()` (`GET /pagelayout/list`), `addSectionToPage(runId, body)`; schemas
  `PageListSchema`, `AddToPageRequestSchema`, `AddToPageResponseSchema`. The mock transport lists two
  pages and refuses to add (its runs publish no section).
- `usePagesQuery`, `useAddToPageMutation`.
- `features/queue/ui/add-to-page-dialog.tsx`: pick a page, Add; on success the template's name and
  "Open the page" (`#/<client>/layout-builder/page/edit/<id>`); the backend's reason on failure.
- The canvas bar has an "Add to page" button.
- `src/test/setup.ts`: `hasPointerCapture` stubs, which Radix Select needs in jsdom.

## Checked

- Two tests in `queue-page.test.tsx` (adds to the chosen page on desktop and says where; shows the
  backend's reason), one in `http-transport.test.ts`. Studio: 344 pass, `tsc -b` and `oxlint` clean.

## Not checked

- In a signed-in browser (with ticket 08).
