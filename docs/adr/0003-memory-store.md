# 0003 — Memory store, embeddings and consolidation

Date: 2026-10-29 · Status: accepted; tenant overrides of skills are gone, and what differs by tenant is house facts (ADR 0010); skills can be loaded on demand (ADR 0011); the full memory model, with tenant-wide facts, is ADR 0013

## Decision

- **One table, `memory_items`**, for semantic and episodic memory, with row-level security on `tenant_id`. The app connects as `dugout_app`, which is neither a superuser nor the table owner, so the policy always applies. `withTenant` sets `app.tenant_id` per transaction, and queries also filter on `tenant_id` explicitly as a second check.
- **Semantic facts are versioned rows.** A fact has a `key`. A change is a new `proposed` row, and activating it retires the previous active row, so older versions stay queryable. A partial unique index allows only one active row per key. Only the review command (`pnpm memory:review`) or the seed script activates facts.
- **Episodes** come only from consolidation. Each one carries its source run id, a confidence score and an expiry date (180 days).
- **Hybrid search** combines full-text rank and pgvector cosine rank with reciprocal rank fusion. It searches only active, unexpired rows.
- **Embeddings**: an `EmbeddingClient` for any OpenAI-compatible `/embeddings` endpoint, fixed at 1024 dimensions by the column. With no endpoint configured, a word-hashing embedder is used, so similarity is lexical until a real model is chosen. Changing the model means re-embedding.
- **Procedural memory** is markdown in the agent package: `skills/<name>.md`, plus `skills/tenants/<tenant>/<name>.md` appended as that tenant's override.
- **The context builder** adds skills, then active facts, then episodes whose embedding is similar to the run input. A weak match stays out. At most five lessons and three run records are added, and the builder stops when the next item would exceed 12% of the model's context window. Items are dropped whole.
- **Consolidation is a function called after each run**, not a Temporal workflow. It turns approval rejections into episodes (with a one-line lesson from the fast model) and `memory.propose` calls into proposed facts. Agents get `memory.search` (read) and `memory.propose`, which writes nothing itself.

## Consequences

- If the process dies between the end of a run and consolidation, that run's lesson is lost. Temporal would make consolidation its own durable step.
- Evals use a separate `harness_eval` database that is emptied and re-seeded on every run, so dev memory never changes eval results.
