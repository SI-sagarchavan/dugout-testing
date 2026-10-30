# 02 · Artifact store by content hash

Status: ready-for-agent
Type: task

## What

A store for big immutable files that runs refer to by id: images, exports, generated documents, intermediate results.

- **Interface:** `put(tenantId, bytes, contentType) → id`, `get(tenantId, id)`, `exists`. The id is the content hash (`sha256-…`), stored under `<tenant>/artifacts/<hash>`.
- **Two adapters:** the local filesystem for development and tests, and S3 for deployment. The bucket, prefix and retention come from config.
- **Retention by kind,** set by whoever writes the artifact. Intermediate files expire; accepted results are kept.
- **Run input carries ids, not bytes.** Tools resolve ids only inside the run's tenant, and the tenant comes from the run.
- **Tools get the store through the tool factory's options.** Don't widen `ToolContext` or `RunContext` without raising it first.
- Decide whether `packages/core/src/output-store.ts`, which already stores big text tool outputs by reference, becomes one adapter of this.

## Why

Big inputs and outputs don't belong in run rows, transcripts or events. Content hashes make reuse and caching free (09), and a resumed run finds everything again by id.

## Done when

- Both adapters exist behind one interface, with tests. S3 is tested against a local S3-compatible server or a mock.
- A test shows that one tenant's id can't be read through another tenant's store.
- The worker's deps carry the store, and a tool reads an artifact by id in a test.

## Pointers

- `packages/core/src/output-store.ts`, `packages/contracts/src/tools.ts` (`ToolContext`), `packages/sdk/src/live.ts` (deps)
- For comparison: `trial/apps/api/src/modules/artifacts` (content-addressed, filesystem blob store)
