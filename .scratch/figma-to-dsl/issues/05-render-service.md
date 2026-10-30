# 05 · Render and diff as a service

Status: ready-for-human
Type: infra + task
Blocked by: 01

## What

Rendering needs headless Chromium. It's heavy, and it can crash. Run render and diff outside the worker, as a service the tools call:

- Input: a DSL version id, the tenant's theme, the width, and the screenshot id to compare against.
- Output: the render and diff images as artifact ids, the score, and the failing regions with node ids.
- Results are cached by input (DSL hash, theme version, width), so the same tree is never rendered twice.
- Locally it can run the FanOS harness directly. In AWS it's an ECS service or a Lambda, whichever ticket 01 makes natural.

## Why

The worker image stays small and stable. A crash in Chromium doesn't take down runs. Sections can be rendered in parallel, and the cache stops repeats.

## Done when

- A tool can render and diff one section through the service locally, and gets ids and regions back.
- The deployment target is chosen and noted for `si-build-iac`.
- A repeated request is served from the cache.

## Pointers

- `trial/packages/renderer/src/harness.ts`, `trial/packages/renderer/src/harness/{renderToPng,diff}.ts`
- `trial/apps/surface-studio/server/preview.ts` (renders a run or a tree as a page today)
