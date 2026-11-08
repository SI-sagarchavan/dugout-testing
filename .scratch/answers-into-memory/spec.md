# Answers into memory: no separate answer memory

Status: built 2026-11-08 (tickets 01–08); 09 waits on a person, 10 is half done. Decisions in ADR 0033.

What a person answers when a run asks is kept in the two long-term memories there already are, semantic and episodic, and `answer_memory` goes away. Found comparing the Opus and Haiku `section-builder` runs on the same frame (Handoffs `6213091e`, Nov 7, and `088e88db`, Nov 8): on Nov 7 a person chose "use the existing hook", "one card for every player" and "the icon is overseas"; on Nov 8 the same questions, worded differently, found none of it, Haiku proposed "build a fuller hook" with nothing learned behind it, and that hook is the one that lost the stats.

## What is wrong now

- **A third store.** `answer_memory` (`packages/memory/src/answers.ts`, migration 014) sits beside `memory_items`, with its own write path, its own review command (`pnpm agent memory answers`) and its own "standing" flag that does what an active fact does.
- **Matched by wording.** Two questions are the same when their words embed 0.88 alike, and the embedder is the word hash (`hash-v1`; no `EMBEDDING_*` in `.env`). A question the code writes (`frame.layout`'s) matches every time; one the model writes almost never does. `sb` holds the photo question three ways with three answers ("hide", `…/26718.png`, `…/4661.png`) and build-or-use three ways (build, use_existing, build_fuller).
- **About nothing.** A row says what was asked and answered, not what it was about. "Use the existing hook" is true for one section and false for another, and nothing tells them apart.
- **Never context.** It only prefills a proposal; an agent never reads a decision before it writes its own question. data-bind wrote "a matches count, and a C or VC badge" without knowing a person had already settled this section.
- **Filed under the parent.** Every `sb` row is under `section-builder`, whichever child asked.

## Decisions (2026-11-08)

| Question | Decision |
| --- | --- |
| Where an answer goes | An answer true for the club is a **fact** (semantic). An answer about one section is a **decision** (episodic, a new episode type). Nothing else. |
| What makes the same question | Its **id** from the asking agent's declared list, and, for a section question, the **section**: the structural signature of the tree's root (`subtreeSignature`, `@fanos/dsl`). Never its wording. |
| Standing answers | An active fact with the question's fact key. A person makes it active in `pnpm agent memory review`, as any fact. `standing` and `pnpm agent memory answers` go. |
| Prefill order | A decision on this section, then an active fact, then a proposed fact, then the model's own proposal. |
| Answering without asking | Only from an active fact, and only when no decision on this section differs from it. `source: memory`, as now. |
| Promotion | A tenant question's first answer is proposed as a fact. A section question answered the same on three different sections is proposed as a fact. A person approves either; source episodes stay (`sources`). |
| Context | The tool that learns the section (`frame.load`, `bind.load`) returns what was decided on it before. Not the context builder: the section is not known when the run starts. |
| Whose decision | The agent that asked (the first run in `from`), recorded once. |
| Questions with no declared id | Asked as now, kept in the run record, never learned. |

Industry fit (checked 2026-11-08): three long-term stores as CoALA defines them; preferences as semantic memory and situation → action → result as episodic memory (LangChain memory docs, LangMem guide); lookup by namespace and key as well as search (LangGraph store); consolidation that proposes and keeps its sources. Answering a question from memory without asking is ours; it is kept behind an approved fact.

## The shapes

A question an agent declares, in its spec:

```ts
questions: {
  hook_choice: { scope: "section", about: "use the hook that was found or build a fuller one" },
  photo_url:   { scope: "tenant", fact: "media.player-photo", about: "a player photo's URL from the item id" },
  card_template: { scope: "section", about: "which designed card every item draws in" },
}
```

A decision, in `memory_items`: `kind = 'episodic'`, `episode_type = 'decision'`, `key = '<agent>:<question id>@<section signature>'`, `value` (new `jsonb` column) the typed answer, `content` the sentence an agent and a person read ("On Frame 1984078918, Sagar Chavan chose 'use the existing hook dugout_cricket_player_cards' when asked whether to build a fuller one"), `strength` how many times, `last_seen_at` the latest.

A fact from an answer: `kind = 'semantic'`, `key` the declared fact key, `content` the sentence for the system prompt, `value` the typed answer the harness can answer with.

## Tickets

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | ADR 0033, CLAUDE.md | — |
| 02 | Declared questions | 01 |
| 03 | A run's section | 01 |
| 04 | Decisions and valued facts in the store | 01 |
| 05 | Consolidation records decisions and proposes facts | 02, 03, 04 |
| 06 | Prefill and answering from memory | 02, 03, 04 |
| 07 | What was decided before, in `frame.load` and `bind.load` | 03, 04 |
| 08 | The CLI | 04, 05 |
| 09 | Move `sb`'s answers, drop `answer_memory` | 05, 06, 08 |
| 10 | The Nov 7 → Nov 8 replay, as a test and an eval case | 05, 06, 07 |

## Out of scope

- Real embeddings (`EMBEDDING_PROVIDER=bedrock`): lookup is by key now, so the hash embedder no longer decides what matches. Still worth doing for lessons.
- Run records that say `Input null: completed.`; examples that keep only `bind.publish`'s counts and not the plan. Same memory, separate tickets.
- Turning on episodic reading in the context builder for data-bind and hook-maker: ticket 07 gives them the decisions that matter without it.
