# 0033. What a person answers is a fact or a decision, in memory

Date: 2026-11-08 · Status: accepted · Supersedes ADR 0029's "Learning from answers" (the rest of 0029 stands) · Amends ADR 0013 (memory) · Related: ADR 0025, ADR 0031

## Context

Two `section-builder` runs built the same frame, Frame 1984078918 (a five-card player carousel): Handoff `6213091e` on Nov 7 and `088e88db` on Nov 8. On Nov 7 a person chose "use the existing hook", "one card for every player" and "the icon means overseas". On Nov 8 hook-maker asked the same question in other words. Nothing was learned behind it, so it proposed "build a fuller hook", and the person took it. That hook dropped the stats the design shows.

ADR 0029 put what people answered in a store of its own, `answer_memory`. It had four problems:

1. **A third store.** It sat beside `memory_items` with its own write path, its own review command (`pnpm agent memory answers`) and a `standing` flag that does what an active fact does.
2. **Matched by wording.** Two questions were the same when their words embedded 0.88 alike, and the embedder was the word hash (`hash-v1`). A question code writes (`frame.layout`'s) matched every time; one the model writes almost never did. `sb` held the photo question three ways with three answers, and build-or-use three ways with three answers.
3. **About nothing.** A row said what was asked and answered, not what it was about. "Use the existing hook" holds for one section and not another, and nothing told them apart.
4. **Never context.** It only prefilled a proposal. An agent never read a decision before writing its own question or its need. Every row was also filed under the parent run's agent, whichever child asked.

## Decision

**Two places, no third.** What a person answers goes into the long-term memory there is (CoALA's split, as LangChain and LangMem implement it):

- An answer true for the club is a **fact** (semantic), under a key (`media.image-domain`). A person approves it, as any fact (`pnpm agent memory review`). An approved fact is what a standing answer was.
- An answer about one section is a **decision**: an episode of its own type, `episode_type = 'decision'`, keyed `<agent>:<question id>@<section>`.

Both keep the typed answer in a new `value` column (migration 022), which a question is proposed or answered with. `content` stays the sentence a person and a model read.

**A question is the same by its id and its section, never its words.** An agent declares the questions it asks (`AgentSpec.questions`): each id with its `scope` (`section` or `tenant`), the `fact` key it becomes, if any, and a few words on what it settles. `ask`'s description lists them, so the model uses the same id every time. The run that asks stamps each declared question with `about: { agent, scope, fact?, section?, name? }`. The stamp travels with the question up to the run a person answers, so the answer is learned the same wherever it is answered. A question whose id is not declared is asked as before and nothing is learned from it.

**A run knows its section.** A tool sets it from what it loaded, never the model: `ToolContext.situate({ section, name })`. `frame.load` and `bind.load` do. The section is the IR root's structural signature, signed as the section library signs a section (`computeStructuralSignature`, depth 64), so a decision is about the library's row for that shape. The loop keeps it in the checkpoint (`situation`), so a resumed run still has it. A child started after it is set starts on it (`RunContext.situation`), so hook-maker's `hook_choice` is about data-bind's section without hook-maker knowing the frame.

**Proposals, in order:** a decision on this section, then the active fact, then the latest proposed fact. The first one that fits the question (its kind, its options) becomes `proposed`, and `learned.from` says `decision` or `fact`.

**Answering without asking** happens only from an active fact, which a person approved. It also needs every question of the pause to have one, and no decision on this section that differs from it. It is still `source: memory`.

**Learning** stays consolidation's (ADR 0013). Only an answer a person chose (`source: person`) is learned, and only in the run a person answered. A child does not learn it again.

- A section question becomes a decision of the agent that asked. The same answer again adds to its `strength`. A different answer is a new decision: the earlier one stays as history and the latest is the one read.
- A tenant question's answer is proposed as its fact, unless the fact already says it.
- A section question that names a fact is proposed as that fact once three sections' latest decisions give the same answer. The decisions are kept as its `sources`.

**Context comes from the tool that knows the section.** `frame.load` and `bind.load` return `before`: what people decided on this section, newest first, at most ten, read with the run's verified tenant. The context builder does not do it, because the section is not known when the run starts. data-bind's skill keeps to `before`: it names the chosen hook in hook-maker's need, and does not ask those questions again.

Decisions expire like other episodes (180 days, pushed back each time one is seen again). The section is the strict structural signature: a change to the frame's structure is a new section.

`answer_memory` goes (migration 023). Its rows name no section, so none can become a decision. The three kinds that hold for the club become proposed facts: the image domain, the player photo URL a person gave, and that carousels loop. The rest are dropped.

## Consequences

- One memory with two kinds of long-term items, and one review command for what a person makes true for the club. `pnpm agent memory answers` and `standing` are gone. `pnpm agent memory decisions` lists and forgets decisions. `memory review` edits a proposal's sentence and answer before approving it. `memory fact --value` writes a fact with an answer.
- `Learned` gains `from`, and `AskedQuestion` gains `about`. Both are optional, so hosts that mirror them (wnm-fanxp-backend, Surface Studio's queue card) keep working, and can show "decided on this section" and "house fact" apart when they take them up.
- An agent's questions are part of its spec. A new question it should remember needs an id there, and its skill names it.
- frame-match asks per container, but a decision is per section. A section with two carousels shares one `items`, `autoplay` and `loop` decision.
- A section is signed from its IR. When data-bind cannot read the IR (a preview with no IR beside it), the run has no section, and its section questions are asked and not learned.
- Answering from memory without asking is ours: no framework does it. It is kept behind a fact a person approved.
