# 05 · Index when a Handoff arrives, and backfill

Status: in progress
Type: task
Blocked by: 02, 03, 04

## What

A job, not an agent tool, the way consolidation writes memory.

- For a Handoff: read its IR and plates by ref (`plane.getExport` and artifacts today; `surface.getSend` and signed S3 URLs later, ADR 0027), parse the IR and run `detectLayout` with the built `@fanos` packages (loaded as frame-match's `toolchain.ts` does), then `findSections`.
- For each section: a signature already in the library gets one more source and nothing else (no cut, no caption, no embedding). A new one: cut its picture (pngjs), `CropStore.put`, `summarize`, caption, `SectionLibrary.add`.
- The IR is held only while its Handoff is indexed; a backfill indexes one Handoff at a time.
- When it runs: the worker queues it when a Handoff arrives (`pnpm agent watch` sees each one). `pnpm agent library index --tenant <t> [--handoff <id> | --all]` indexes one or backfills every Handoff of the tenant, printing what it added, what it only saw again, and what it left out and why.

## Done when

- Indexing a Handoff in a test (a fake control plane, the hash stand-in, a scripted captioner) leaves its sections in the library; indexing it again adds no rows and no sources.
- A section seen in a second Handoff gets a second source and is not captioned again.
- Backfill on the demo tenant indexes every Handoff in the local control plane.

## Comments

2026-11-06: `indexHandoff` (`packages/library/src/indexer.ts`) and `pnpm agent library index` are in, with tests on a fake source (added, seen again, a second Handoff, a caption that fails and is made later, no captioner). Run on the 20 latest local Handoffs: 23 sections, every repeat across Handoffs recognised, one left out with its reason. Left: the worker queuing it when a Handoff arrives, and the FanXP backend's Handoffs (`createHandoffSource` in frame-match) as a second `HandoffSource`.
