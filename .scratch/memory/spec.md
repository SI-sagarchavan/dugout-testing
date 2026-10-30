# Memory: working, episodic, semantic and procedural

Status: planned 2026-10-30; decisions in ADR 0013.

The four memory types as the CoALA paper defines them (arXiv 2309.02427), built the way most harnesses now converge on, with our one deliberate difference: a person approves every long-term fact before a run uses it.

## Decisions (2026-10-30)

| Question              | Decision                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scopes                | Memory belongs to a tenant or to every tenant; an agent owns none. Every agent of a tenant reads all of the tenant's facts, lessons and run records. Each item records which agent produced it, for provenance and a small ranking lift. Global memory is the skills in git, changed by pull request. The tenant comes from the verified run, never from the model. |
| Who makes a fact live | A person, always. Agents and the after-run extractor only propose.                                                                                                                                                                                                                                                                                                  |
| Long runs             | Compaction (summary of older turns, recent turns as they are; the saved transcript keeps everything) plus a small notes block the agent writes, which survives compaction.                                                                                                                                                                                          |
| Procedural learning   | A job suggests skill edits from repeated lessons; a person applies them through a pull request. Nothing changes a skill on its own.                                                                                                                                                                                                                                 |

## The four types

| Type       | Holds                                                           | Written by, when                                                               | Read by                                                                 |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Working    | The run's transcript, checkpoint and notes block                | The loop after every step (ADR 0006); the agent through `notes.write`          | Every model call: compacted transcript + notes                          |
| Episodic   | One record per finished run, and lessons from reviewer feedback | Consolidation after the run                                                    | Top episodes ranked by relevance, recency and importance, in the prompt |
| Semantic   | Versioned facts of the tenant; pinned or searchable             | Proposals from agents (`memory.propose`) and the extractor; a person activates | Pinned facts in the prompt; the rest through `memory.search`            |
| Procedural | Skills in git (always loaded or on demand, ADR 0011)            | People; the suggestion job drafts edits                                        | The prompt, or `skill.load`                                             |

## What other harnesses do that we adopt

- A small core always in context, the rest pulled on demand (Letta, OpenAI Agents SDK sandbox memory, Anthropic memory stores).
- Scope keys set by the host (LangGraph namespaces, ADK `user:`/`app:`, mem0 ids).
- Extraction checked against the most similar existing memories: add, update or skip (mem0, LangMem, ADK Memory Bank).
- Consolidation off the agent's path, after the run.
- A summary that replaces older context, a recent tail kept word for word, and the full log in storage (Anthropic, ADK, LangGraph, Letta), with a warning to the agent before it happens.
- Duplicates reinforce instead of piling up; ranking mixes relevance, recency and importance (Generative Agents, LangMem).
- Updates append and retire, never overwrite (Zep, Managed Agents versions): our facts already work this way.

## Tickets

| #   | Ticket                                                                             | Status          | Blocked by |
| --- | ---------------------------------------------------------------------------------- | --------------- | ---------- |
| 01  | [Memory belongs to the tenant](issues/01-tenant-wide-facts.md)                     | resolved        |            |
| 02  | [Episodes: run records, reinforcement, ranking](issues/02-episodes.md)             | resolved        | 01         |
| 03  | [Facts: pinned and searchable, extracted after runs](issues/03-fact-extraction.md) | ready-for-agent | 01         |
| 04  | [Working memory: compaction and notes](issues/04-working-memory.md)                | ready-for-agent |            |
| 05  | [Skill-edit suggestions](issues/05-skill-suggestions.md)                           | ready-for-agent | 02         |
| 06  | [Memory evals](issues/06-memory-evals.md)                                          | ready-for-agent | 02, 03, 04 |

## Not now

- User-level memory (needs a verified user id from the host).
- Threads spanning runs (one request is one run).
- A knowledge graph (Zep/Graphiti); versioned rows with provenance cover our needs.
