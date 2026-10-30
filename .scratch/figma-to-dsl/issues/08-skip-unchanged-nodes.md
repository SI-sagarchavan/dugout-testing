# 08 · Skip unchanged nodes on a re-send

Status: ready-for-agent
Type: task
Blocked by: harness 09

## What

Designers send the same page again after small edits. Using the harness step cache (harness 09), key each section's accepted result by the content hash of its Figma node plus the compiler and DSL versions. On a new run, a section whose key matches reuses its earlier result, so only changed sections run tasks. Studio already does the simplest form of this: clicking compile twice returns the first run.

## Why

Re-sends become cheap and fast, and they don't produce a slightly different result for a section nobody changed.

## Done when

- A second run with one section changed runs a task for that section only, and reuses the rest, shown in a test.
- A new compiler or DSL version invalidates the cache.

## Pointers

- `trial/apps/surface-studio/server/plugin-api.ts` (`startCompile`, "idempotent by export")
- Harness 02 (artifact store), 04 (runs with tasks), 09 (step cache)
