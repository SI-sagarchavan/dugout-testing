# 0013 — The memory model: four types, two scopes, people approve facts

Date: 2026-10-30 (updated 2026-11-01 to match what is built) · Status: accepted; shared memory for every tenant and each sport is ADR 0014 · Extends ADR 0003 and ADR 0006

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

**What is built, 2026-11-01.** Tenant-wide facts, episodes that reinforce, approved examples, lesson ranking and promotion, and recalled memory kept apart from the system prompt. Marked **not yet built** below: compaction and the notes block (`.scratch/memory/issues/04-working-memory.md`), the after-run fact extractor, pinned facts and the check against similar facts (issue 03), and skill suggestions (issue 05). The first version of this ADR described them as if they existed.

## Decision

- **Four types.**
  - Working: the transcript and checkpoint. **Not yet built:** a notes block the agent writes (issue 04).
  - Episodic: lessons, approved examples and run records.
  - Semantic: versioned facts.
  - Procedural: skills in git.
- **Memory belongs to a tenant, or to every tenant.** An agent is one definition that every tenant's runs use; it owns no memory.
  - Tenant memory is the facts, lessons and run records in Postgres. Every agent of the tenant reads all of it, and row-level security keeps one tenant's rows from another's runs.
  - Each item records the agent whose run produced it. That is provenance and a small ranking lift for the agent's own lessons, never a filter.
  - Global memory is what every tenant's runs read: the skills in git, changed only through a pull request, because a tenant's lessons can hold that tenant's names, fixtures or editors' words. ADR 0014 adds shared facts and lessons, for every tenant or for one sport, which a person approves.
  - The tenant comes from the verified run, never from the model. No user-level memory until hosts send a verified user id.
- **People make facts live.** Agents propose with `memory.propose`, consolidation proposes a lesson that keeps coming back (below), and only `pnpm memory:review` (or seeding) activates. A proposal is inserted as the next version of its key; nothing compares it with similar facts first. **Not yet built:** the after-run extractor, and the check of a proposal against similar facts so it arrives as a new key, an update, or not at all (issue 03).
- **One tier of facts.** Every active fact of the tenant, and the shared facts of ADR 0014, are put in the prompt, up to `factsBudgetTokens` (default 6,000 tokens; whole facts are dropped, never cut), and `memory.search` finds the rest. **Not yet built:** pinned and searchable tiers, which would stop loading every fact (issue 03).
- **Episodes reinforce.** A lesson close to an active one (cosine similarity 0.9 or more) strengthens it instead of adding a row. Retrieval is the cosine similarity of the stored embedding to the run input. A lesson's embedding also includes the input of the run that produced it, so a later run with a similar input can find it; the stored text is still the lesson. An episode below the minimum similarity (0.2) stays out.
- **Lessons are ranked, not only matched.** Up to 20 lessons above the minimum similarity are fetched, plus any live lesson seen at least 3 times at any similarity. They are ranked by `similarity + 0.05 * min(strength - 1, 4) + 0.05 * exp(-ageDays / 60) + 0.05 if the lesson came from the reading agent`, with age counted from `lastSeenAt`. The top five are put in the prompt. The agent term is a lift, never a filter.
- **A lesson seen three times is proposed as a fact.** When a lesson's strength reaches exactly 3, consolidation proposes it as a house fact under the key `lesson.<first 8 hex of sha256 of its text>`, clipped to 500 characters, unless that key has any version already (so a rejected one is not proposed again). A person still approves it with `pnpm memory:review`. The fourth repeat proposes nothing.
- **Approved work is kept as an example.** When a run completes and an editor approved a write call, consolidation stores one `example` episode: `<tool>: <the last approved call's input>`, with the run input as its situation, confidence 1 and the 180-day expiry. An example over 4,000 characters is not stored. Examples do not reinforce, `memory.search` never returns them, and `shared.ts` still promotes only lessons. A run that was rejected, failed or cancelled stores none.
- **Everything stored is redacted.** `consolidateRun` runs the content and situation of every episode through the core redactor (`createRedactor`) before it writes, so an email in a run input is not stored.
- **Recalled memory is separate from the system prompt.** `buildContext` returns `text` and `recalled`.
  - `text` is what holds for the tenant whatever the input: skills, the on-demand skill list, house facts, shared facts. It is appended to the agent's instructions.
  - `recalled` is what depends on the input: `<recalled_memory>`, `Today is <date>.`, the lessons, and up to two `## Approved examples` (which say to use them for style and structure only, and never to copy their facts, names or numbers), then `</recalled_memory>`. The loop puts it at the start of the first user message, a blank line before the input. It is empty, and the input is sent alone, for an agent that does not read episodic memory.
  - Lessons and examples share `recalledBudgetTokens` (default 6,000). Skills count against neither cap, and keep the 12% of the context window and the error when they do not fit. The date comes from a `now` option, because the context builder runs outside the loop.
- **Run records are written but not recalled.** The `## Similar past runs` section is gone: a record reads `Input {...}: completed.`, which tells the model nothing. Consolidation still writes one per ended run, for the reviewer's words and for `memory.search`.
- **Long runs compact.** **Not yet built** (issue 04). A long run is sent whole. The plan: older turns sent as a summary and recent ones as they are, after a warning, with the saved transcript and a notes block kept.
- **Skills change only by pull request.** **Not yet built:** a job that suggests skill edits from repeated lessons (issue 05). Today, ADR 0014's promotion proposes shared facts and lessons for a person to approve, and skills are edited by hand.

## Consequences

- `memory_items.agent_id` is nullable and means "produced by"; one fact per tenant and key is active (migration 006). Two activations of one key take turns under an advisory lock.
- A seed file is one list per tenant. A fact that concerns one kind of work says so in its text ("Match previews: at most 120 words"), since every agent of the tenant reads it.
- **The system prompt no longer changes with the input.** The system prompt holds the first of the two cache points (`addCachePoints` in the Bedrock client). Recalled lessons used to sit in it, so two runs of one tenant with different inputs shared no cached prefix. Now they send the same system prompt, and only the first user message differs. Recalled text also loses system-level trust: it is in a user message, marked as recalled memory.
- Lessons are recalled across the tenant's agents, and so are examples: neither is filtered by agent, so an approved example from one agent can reach another if the inputs are alike. Agent prompts say "the lessons in the recalled memory", not "below".
- Compaction, when built, must respect Claude 5.5's rule that reasoning is bound to an unedited history (see `.scratch/memory/issues/04-working-memory.md`).
- `memory.search` returns an item only if it matched the text or its cosine similarity is at least 0.2, so an unrelated query returns nothing.
- Work is tracked in `.scratch/memory/`.
