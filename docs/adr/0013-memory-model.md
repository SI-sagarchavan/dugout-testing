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
- **Scopes.** A fact is tenant-wide or belongs to one agent; an agent reads both, and its own wins on the same key. Episodes belong to one agent. Scopes come from the verified run, never from the model. No user-level memory until hosts send a verified user id.
- **People make facts live.** Agents propose with `memory.propose`; the after-run extractor proposes; only `pnpm memory:review` (or seeding) activates. Proposals are checked against similar facts first, so they arrive as a new key, a new version of an existing key, or not at all.
- **Two tiers of facts.** Pinned facts are always in the prompt; the rest are searched with `memory.search`.
- **Episodes reinforce.** A repeat strengthens the existing episode. Retrieval ranks by relevance, recency and importance.
- **Long runs compact.** Older turns are sent as a summary and recent ones as they are, after a warning. The saved transcript keeps everything, and the notes block survives.
- **Skills change only by pull request.** A job suggests edits from repeated lessons.

## Consequences

- `memory_items.agent_id` becomes nullable; the one-active-fact index treats null as one value (`nulls not distinct`, Postgres 15+).
- Seed files gain a `shared` section.
- Compaction must respect Claude 5.5's rule that reasoning is bound to an unedited history (see `.scratch/memory/issues/04-working-memory.md`).
- Work is tracked in `.scratch/memory/`.
