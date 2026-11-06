# 02 · Library package, schema and store

Status: resolved
Type: task
Blocked by: none

## What

`packages/library` (`@dugout/library`), exporting `src/index.ts` as the other internal packages do.

- A migration in `packages/db/migrations/` for `library_sections` with the columns in `spec.md` ("A library entry"): two `vector(1024)` columns with HNSW cosine indexes, a generated `tsv` over `search_text`, `unique (tenant_id, signature)`.
- Row-level security as `memory_items` has it: the app role reads and writes only its tenant's rows (`withTenant`).
- A `SectionLibrary` interface and a Postgres implementation. Callers use the interface only; ticket 12 may move the storage.
- A model's tags, a person's and a person's removals are kept apart; a model describing the section again never undoes a person's edit.

## Done when

- Adding the same signature twice for a tenant keeps one row; another Handoff adds a source; the same Handoff and layer again adds nothing.
- A test shows tenant A cannot read tenant B's sections, through the store or a raw query.
- `pnpm db migrate` applies it on a clean database and on one with data.

## Comments

2026-11-06: done. `packages/db/migrations/013_section_library.sql`; `packages/library/src/store.ts` (`createSectionLibrary`), `crops.ts` (`CropStore`, a directory for now), `embeddings.ts` (`MultimodalEmbeddings`, hash stand-in). `resetDatabase` empties the table too. Tests: `packages/library/tests/store.test.ts`.
