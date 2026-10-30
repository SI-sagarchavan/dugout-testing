# 0013 — The memory model: four types, two scopes, people approve facts

Date: 2026-10-30 · Status: accepted · Extends ADR 0003 and ADR 0006

## Context

ADR 0003 built one store for facts and episodes; ADR 0006 made the run transcript durable. Measured against other harnesses (checked 2026-10-30), four things were missing: long runs never compact, episodes record only rejections, facts are stored per agent even when they hold for the whole tenant, and every fact is loaded into every run.

How others do it:

- **CoALA** defines working, episodic, semantic and procedural memory, and calls writing procedural memory the riskiest. <https://arxiv.org/html/2309.02427v3>
- **LangGraph/LangMem**: namespaced stores scoped from run config; memories written by the agent or by a background manager that adds, updates or deletes against similar ones; prompt optimisation as procedural memory. <https://docs.langchain.com/oss/python/langgraph/memory>, <https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>
- **Letta**: memory blocks always in context plus archival memory searched on demand; older messages evicted into a recursive summary. <https://docs.letta.com/guides/agents/memory-blocks>
- **Mastra**: working memory the agent updates, semantic recall, and an observation log that compresses long histories. <https://mastra.ai/docs/memory/overview>
- **Anthropic**: compaction (a summary replaces older turns), context editing, and a warning before content is cleared; Managed Agents memory stores keep every write as a version. <https://platform.claude.com/docs/en/build-with-claude/compaction>, <https://platform.claude.com/docs/en/managed-agents/memory>
- **Google ADK**: `app:`/`user:`/`temp:` state scopes, and a Memory Bank that consolidates extracted memories. <https://adk.dev/sessions/state/>
- **mem0, Zep**: extraction checked against similar memories; Zep retires contradicted facts instead of deleting them. <https://arxiv.org/html/2504.19413v1>, <https://arxiv.org/html/2501.13956v1>

None of them queues proposed memories for a person to approve.

## Decision

- **Four types.**
  - Working: the transcript, checkpoint and a notes block the agent writes.
  - Episodic: run records and lessons.
  - Semantic: versioned facts.
  - Procedural: skills in git.
- **Memory belongs to a tenant, or to every tenant.** An agent is one definition that every tenant's runs use; it owns no memory.
  - Tenant memory is the facts, lessons and run records in Postgres. Every agent of the tenant reads all of it, and row-level security keeps one tenant's rows from another's runs.
  - Each item records the agent whose run produced it. That is provenance and a small ranking lift for the agent's own lessons, never a filter.
  - Global memory is what every tenant's runs read: the skills in git. It changes only through a pull request, because a tenant's lessons can hold that tenant's names, fixtures or editors' words. Repeated lessons reach it as suggested skill edits (the procedural point below).
  - The tenant comes from the verified run, never from the model. No user-level memory until hosts send a verified user id.
- **People make facts live.** Agents propose with `memory.propose`; the after-run extractor proposes; only `pnpm memory:review` (or seeding) activates. Proposals are checked against similar facts first, so they arrive as a new key, a new version of an existing key, or not at all.
- **Two tiers of facts.** Pinned facts are always in the prompt; the rest are searched with `memory.search`.
- **Episodes reinforce.** A repeat strengthens the existing episode. Retrieval ranks by relevance, recency and importance.
- **Long runs compact.** Older turns are sent as a summary and recent ones as they are, after a warning. The saved transcript keeps everything, and the notes block survives.
- **Skills change only by pull request.** A job suggests edits from repeated lessons.

## Consequences

- `memory_items.agent_id` is nullable and means "produced by"; one fact per tenant and key is active (migration 006). Two activations of one key take turns under an advisory lock.
- A seed file is one list per tenant. A fact that concerns one kind of work says so in its text ("Match previews: at most 120 words"), since every agent of the tenant reads it.
- Compaction must respect Claude 5.5's rule that reasoning is bound to an unedited history (see `.scratch/memory/issues/04-working-memory.md`).
- Work is tracked in `.scratch/memory/`.
