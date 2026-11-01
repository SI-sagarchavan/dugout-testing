# Build plan (local phases)

Scope: harness core, memory, one sample agent (match preview writer), eval suite — all on a laptop. Figma→DSL, sitemap agent and AWS come later on the same core.

## Locked decisions

TypeScript (Python only as isolated MCP services) · own thin core, LangGraph only inside one agent behind `AgentRuntime` · Temporal (workflow per run, activity per model/tool call) · ECS Fargate · Valkey Streams (no-eviction) for live events · Aurora Postgres + pgvector, S3 · MCP as tool contract, typed tools only · Amazon Bedrock (ConverseStream) behind `ModelClient` (ADR 0012) · OpenTelemetry → Langfuse.

## Tool pipeline order

registry + spec check → tenant injection → policy check → approval (write/listed) → execute w/ timeout+retry → redact (secrets, PII: email, phone, Aadhaar, PAN) → emit events (`tool.started|completed|denied`).

## Tasks (depends on)

**Epic 1 harness core:** H1 contracts · H2 Anthropic client (H1) · H3 registry+pipeline (H1) · H4 policy+redactor (H3) · H5 loop+transcript+compaction (H1) · H6 Valkey event log + SSE resume (H1) · H7 Temporal workflow + approval signal (H5) · H8 Langfuse tracing (H6) · H9 smoke agent + acceptance (H7)
**Epic 2 memory:** M1 schema+RLS (H1) · M2 embeddings+hybrid search (M1) · M3 procedural skills loader (H5) · M4 context builder + `memory.search` (M2,M3) · M5 episodic consolidation (H7,M1) · M6 semantic proposals+review (M1) · M7 isolation/provenance suite (M4,M5,M6)
**Epic 3 sample agent:** S1 sample data, two tenants (M6) · S2 tools fixtures.get/team.stats/draft.save (H3,S1) · S3 skill+spec (M3,S2) · S4 feedback command (H7,M5)
**Epic 4 evals:** E1 cases (S3) · E2 deterministic graders (E1) · E3 model judge (E1) · E4 runner + pass-rate gate (E2,E3) · E5 memory evals (S4,E4) · E6 red-team (E4)

A phase ends when its gate is demonstrated, not when tasks close.

## Status (2026-10-30)

Built and tested locally, except H7, which is parked: Temporal replaces the worker's claiming before production (ADR 0009).

| Task  | State  | Notes                                                                                                    |
| ----- | ------ | -------------------------------------------------------------------------------------------------------- |
| H1–H5 | done   | H2 is a Bedrock client (ADR 0012, replacing ADR 0001); the loop runs over `Steps` (ADR 0002)             |
| H6    | done   | Valkey stream per run, Postgres record, SSE resume (ADR 0004)                                            |
| H7    | parked | Temporal kept out for local work; `docker compose --profile temporal up` still starts it                 |
| H8    | done   | Langfuse via OpenTelemetry; off unless both keys are set                                                 |
| H9    | done   | `pnpm eval smoke`                                                                                        |
| M1–M7 | done   | Consolidation runs right after each run, not as a workflow (ADR 0003)                                    |
| S1–S4 | done   | S4 is the approval prompt in `pnpm agent match-preview`                                                  |
| E1–E6 | done   | `pnpm eval match-preview`; the judge reports but does not gate                                           |
| D1    | done   | Runs' working memory saved in Postgres; approvals end the invocation; crash recovery by lease (ADR 0006) |
| A2    | done   | Sitemap agent (`agents/sitemap`): first live use of `final` structured output; `pnpm eval sitemap`       |
| A3    | done   | `defineAgent` in `@dugout/sdk` (ADR 0007): both agents on it; `pnpm agent <id>`                          |
| H10   | done   | Tool-call arguments stream (ADR 0008); the per-request response modes left with the API (ADR 0009)       |
| H11   | done   | `pnpm worker` runs agents, `pnpm agent` queues and follows runs; no HTTP API; Docker image (ADR 0009)    |

## Embedding model

Decided for now (ADR 0003): any OpenAI-compatible `/embeddings` endpoint at 1024 dimensions, set by `EMBEDDING_BASE_URL`. Without one, a word-hashing embedder keeps hybrid search working with lexical matching only. Choosing the production model is still open.
