# 02 · Library package, schema and store

Status: ready-for-agent
Type: task
Blocked by: none

## What

`packages/library` (`@dugout/library`), exporting `src/index.ts` as the other internal packages do.

- A migration in `packages/db/migrations/` for `library_sections` with the fields in `spec.md` ("A library entry"): two `vector(1024)` columns with HNSW cosine indexes, a generated `tsv` over caption and tags, `unique (tenant_id, signature)`.
- Row-level security as `memory_items` has it: the app role reads and writes only its tenant's rows (`withTenant`).
- A `SectionLibrary` interface (`upsert`, `addSource`, `get`, `search`, `setTags`, `hide`) and a Postgres implementation. Callers use the interface only; ticket 12 may move the storage.
- Tags are stored with who added them (`model` or `person`); a person's tag is never overwritten by a re-index.

## Done when

- Upserting the same signature twice for a tenant keeps one row and two sources.
- A test shows tenant A cannot read or write tenant B's sections.
- `pnpm db migrate` applies it on a clean database and on one with data.
