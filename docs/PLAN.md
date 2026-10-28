# Build plan (local phases)

Scope: harness core, memory, one sample agent (match preview writer), eval suite — all on a laptop. Figma→DSL, sitemap agent and AWS come later on the same core.

## Locked decisions

TypeScript (Python only as isolated MCP services) · own thin core, LangGraph only inside one agent behind `AgentRuntime` · Temporal (workflow per run, activity per model/tool call) · ECS Fargate · Valkey Streams (no-eviction) for live events · Aurora Postgres + pgvector, S3 · MCP as tool contract, typed tools only · official provider SDKs behind `ModelClient` · OpenTelemetry → Langfuse.

## Tool pipeline order

registry + spec check → tenant injection → policy check → approval (write/listed) → execute w/ timeout+retry → redact (secrets, PII: email, phone, Aadhaar, PAN) → emit events (`tool.started|completed|denied`).

## Tasks (depends on)

**Epic 1 harness core:** H1 contracts · H2 Anthropic client (H1) · H3 registry+pipeline (H1) · H4 policy+redactor (H3) · H5 loop+transcript+compaction (H1) · H6 Valkey event log + SSE resume (H1) · H7 Temporal workflow + approval signal (H5) · H8 Langfuse tracing (H6) · H9 smoke agent + acceptance (H7)
**Epic 2 memory:** M1 schema+RLS (H1) · M2 embeddings+hybrid search (M1) · M3 procedural skills loader (H5) · M4 context builder + `memory.search` (M2,M3) · M5 episodic consolidation (H7,M1) · M6 semantic proposals+review (M1) · M7 isolation/provenance suite (M4,M5,M6)
**Epic 3 sample agent:** S1 sample data, two tenants (M6) · S2 tools fixtures.get/team.stats/draft.save (H3,S1) · S3 skill+spec (M3,S2) · S4 feedback command (H7,M5)
**Epic 4 evals:** E1 cases (S3) · E2 deterministic graders (E1) · E3 model judge (E1) · E4 runner + pass-rate gate (E2,E3) · E5 memory evals (S4,E4) · E6 red-team (E4)

A phase ends when its gate is demonstrated, not when tasks close.

## Open decision needed before M2

Embedding model (Voyage / Bedrock / local) behind an `EmbeddingClient` interface; vector dimension is fixed in the schema.
