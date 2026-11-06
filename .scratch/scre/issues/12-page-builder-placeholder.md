# 12 · The page builder shows a section as a placeholder

Status: done (2026-11-06)
Type: task
Blocked by: 10

## What

wnm-fanxp-frontend `apps/fanxp`, the page builder:

- `features/layout-builder/page/lib/surfaceSectionTemplate.ts`: `isSurfaceSectionTemplate` (content type
  24, or a template carrying `data.surface_section`), `getSurfaceSectionMeta`, `surfaceStudioPreviewHref`
  (`#/<client>/surface-studio/queue/<handoffId>`).
- `ui/device-renderer/SurfaceSectionPlaceholder.tsx`: drawn like the plugin / dynamic block placeholder:
  "Surface section", the section's name, its short digest, and "Preview in Surface Studio" (new tab).
- `FanxpTemplateRenderer.tsx`: draws the placeholder for a section instead of the template; no Duplicate
  or Export on it (the page builder never holds the DSL, so a copy would be a section without one).

## Checked

- 8 tests on the helpers, 4 on the renderer (placeholder, link, no duplicate/export, other templates
  untouched). Device-renderer suite: 137 pass. `tsc` clean.
