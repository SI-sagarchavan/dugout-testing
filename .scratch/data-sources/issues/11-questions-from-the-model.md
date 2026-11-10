# 11 · Every question is the model's: tools report what is open, the agent asks

Status: in-progress (data side, the approval wording and the Cast budget done; frame-match questions still in code)
Type: task
Blocked by: none

## What

No question a person sees may be written in code: not its wording, not its options, not which
answers it accepts. Tools report what is open, with the evidence and a proposal. The agent's model
decides whether to ask, writes the question with `ask`, reads the answer, and passes what it
decided to a tool as ordinary input. What people answer is learned in memory (ADR 0033), so the
agents improve over time without anyone adding questions in code.

Today some questions are written in code, and the model-written ones have their options dictated
by instructions. That is why run `f77d8a76`'s data question offered only "Stand-in" and "Unbound",
and a person had to guess that pasting an API URL into "Other" would work.

### Questions written in code today

| Where | What it asks | How the answer is read |
|---|---|---|
| `agents/frame-match/src/layout.ts:289` `layoutQuestions`, thrown from `tools.ts:1135` (`frame.layout`) | `kind`, `items`, `autoplay`, `loop`, `platform`: fixed text and options ("Every 3 seconds", …) | `applyLayoutAnswers` matches option values |
| `agents/frame-match/src/layout.ts` (`ask: string[]` on each layout, `splitProposed`) | pre-written sentences ("How many items does … hold in all? (proposed: …)") returned by `frame.load` | parsed back out of the sentence |
| `agents/frame-match/src/slots.ts:167` `splitQuestion`, thrown from `tools.ts:592` (`settleSplit`) | `section_split`: "Which parts of this frame are one section?" | `joinsFrom` |
| `agents/section-builder/src/agent.ts:324,351` `castBudgetQuestion` / `slotsToBind` | Cast budget: "first", "all", "none" | matches `"all"` / `"none"` |
| `packages/contracts/src/questions.ts:213` (the approval) | "Approve <tool>?" / "<tool> writes. It runs only when a person approves it." | review decision |

### Options dictated by instructions today

- data-bind `data_source`: `agents/data-bind/src/agent.ts:24` and `skills/bind.md:83` fix the
  options to `stand_in` and `unbound`, with feeds only through "Other".
- hook-maker `hook_choice`: `agents/hook-maker/src/agent.ts:22` and `skills/hook-maker.md:37` fix
  "build a fuller hook / use it as it is".

## Change

1. **Tools report, never ask.** A tool that reaches something it cannot settle returns it in its
   result, as data, under one generic shape (contracts):
   `open: [{ id, about, evidence, candidates?, proposed?, canTake, before? }]`.
   - `id`: the question id memory keys on (ADR 0033). It is a name, not a sentence.
   - `evidence`: what the tool found, with real values.
   - `candidates`: answers the tool can act on, each with what it does.
   - `canTake`: what else the next tool accepts. For example, "feed URLs: a connector is built on
     each", or "a number of items".
   - `before`: what memory proposes. This is a decision on this section, else a fact, as
     `proposed` is today.

   `frame.load`, `frame.layout`, `bind.load`, `agent.hookMaker`'s result and `page.build` return
   `open` instead of throwing `AwaitingAnswers` with built questions. `layoutQuestions`,
   `splitQuestion`, `castBudgetQuestion`, the `ask: string[]` sentences and `splitProposed` go.
2. **The model asks.** It reads `open` and decides for each item:
   - answer it from memory, when memory holds an active fact for it;
   - decide it itself, saying why, when the evidence settles it;
   - or ask a person with `ask`.

   It writes the question, the options and the `why` from `evidence`, `candidates` and `canTake`.
   Everything the next tool can take is offered to the person: a candidate becomes an option, and
   what `canTake` accepts is said in the question or offered as a text option.
3. **Answers come back as tool input.** The model passes what was decided, whoever decided it, to
   the tool that acts: `frame.layout` takes the layout config, a split takes `joins`, `page.build`
   takes the slots to bind, and `agent.hookMaker` takes `need.sources`. No code reads an answer's
   option value. The tool records how each open item was settled: `{ id, by: "person" | "memory" |
   "agent", value }`. That record goes in the run's output and thread note, and evals grade it.
4. **Instructions and skills describe, they do not script.** They say what each open item means,
   what the tools can do with each kind of answer, and when asking is worth a person's time. They
   no longer give fixed options or fixed wording. This covers data-bind (`data_source`,
   `picture_url`, `item_count`, …), hook-maker (`hook_choice`) and frame-match (layouts, split).
5. **Memory stays keyed by id.** The question ids in each spec's `questions` remain as names memory
   learns under, with their `scope` and `fact` key (ADR 0033); they hold no wording. `about` is
   stamped as today. An answer is learned whichever words asked it.
6. **The approval gate stays in code; its words don't.** Write tools stay behind approval (a repo
   rule). The fixed sentence in `packages/contracts/src/questions.ts:213` is replaced by what the
   model said it is doing and why (the call's stated reason, required on every write call), plus
   the call's input. The options stay approve, reject and change, because they are the gate itself,
   not a question.
7. **A question reaches the person when it is asked.** With slots bound one at a time, a slot that
   asks no longer waits for the next slot to finish before its question surfaces (seen in run
   `f77d8a76`, 90 s).

## Done when

- `grep` finds no question text in tool code. `AwaitingAnswers` is thrown only by the `ask` tool,
  by the approval gate, and by a child run passing its question up.
- Tests (fake model, two unrelated designs, one not cricket):
  - a frame with a carousel, the same with a frame split the finder is unsure of, and a slot with
    no data source each return `open` with evidence;
  - the model's `ask` offers every candidate and what `canTake` accepts;
  - the answer, fed back as tool input, is applied, and is learned under its id;
  - an item memory holds an active fact for is settled `by: "memory"` with no question.
- A live run on a Handoff with a carousel and a slot with no data asks in the model's words, and
  its data question offers giving the API endpoint.
- ADR 0029 (asking a person) gets an amendment: tools report, the agent asks.

## Pointers

- `packages/contracts/src/questions.ts` (`Question`, the review question), `packages/core/src/tools.ts`
  (`AwaitingAnswers`), the `ask` tool
- `agents/frame-match/src/layout.ts`, `slots.ts`, `tools.ts` (`settleSplit`, `frame.layout`)
- `agents/section-builder/src/agent.ts` (`castBudgetQuestion`, `slotsToBind`, the slot pass)
- `agents/data-bind/src/agent.ts`, `src/ending.ts`, `skills/bind.md`;
  `agents/hook-maker/src/agent.ts`, `skills/hook-maker.md`
- ADR 0029, ADR 0033

## Comments

2026-11-09: **Done:** the `OpenItem` / `Settled` contracts; data-bind reports `data_source` as an open item (`bind.load`: evidence incl. the club's feeds, candidates, `canTake` naming feed URLs as `need.sources`), and its instructions and skill no longer dictate options (`stand_in` / `unbound` are gone; the model offers the candidates and what `canTake` accepts); hook-maker's `hook_choice` is written the same way; a pipeline no longer starts a queued slot once another has paused for a question (item 7); ADR 0029 amended. **Not done, and why:** frame-match's `layoutQuestions` / `splitQuestion` and their answer parsing (`applyLayoutAnswers`, `joinsFrom`), section-builder's `castBudgetQuestion`, the `ask: string[]` sentences, the review's fixed sentence (a required `reason` on every write call touches every write tool and test), and the `Settled` record in outputs. Frame-match's accuracy is gated by a live eval I cannot run here, so converting its flow (`frame.layout` takes the layout config as input, `frame.load` returns `open`) should be done with that eval at hand. `grep` for question text in tool code is therefore not yet clean.

2026-11-10 (approval and section-builder): **Done:** the approval's words are the model's. Every write that waits for a yes takes a required `reason` in its model-facing input, added by the tool pipeline (`packages/core/src/tools.ts`: `asksReason`, `toolDefinition`, `preflight`), checked and stripped before the tool's own schema reads the input (strict tools stay unchanged), and `reviewQuestion` uses it as the question's `why`; the call's input is still `subject.input`; options stay approve, change, reject. A call saved before this (a waiting or approved call replayed) is read without a reason, and its review only says the call writes. The scripted test model supplies a stand-in `reason` when a script leaves it out, so existing scripts did not change. The terminal shows it ("Why"). Child writes (`agent.<child>`) and pipelines that write get it the same way, with no per-tool code. section-builder: `page.build` reports `cast_budget` as an open item (evidence with the slots and the estimated live runs against 25 an hour; candidates, each a list of part names; `canTake`) and binds nothing; the model settles it (from memory with `ask` under the declared id `cast_budget`, fact `cast.budget`; from the evidence; or by asking a person) and calls `page.build` again with `bind` (part names; empty binds none) and `decidedBy`. `castBudgetQuestion` and the reading of "all" / "none" are gone; `Pipeline.input`, `PipelineContext.args` and `isOpenResult` (an open answer is not a completed call) are in the SDK; the output has `settled` (`Settled`) and the thread note says it. Tests: `agents/section-builder/tests/fan-out.test.ts` (open item with evidence; the decision applied as input; unknown names refused; a run where an active fact answers with no person stopped for, source `memory`), `packages/core/tests/ask.test.ts` (reason required, stripped, shown), `packages/sdk/tests/pipeline-answers.test.ts`.
**Not verified:** a live run (no model access here). `decidedBy` is what the model says, not proven by code. **Still open here:** frame-match's layout and split questions (the other half of this ticket), and the `Settled` record for frame-match's and data-bind's open items.

2026-11-10, frame-match: **Done:** `frame.load` returns `open` (and `openRule`) instead of throwing `AwaitingAnswers`: each container's items (`kind`, `items`, `autoplay`, `loop`, `platform`; the compiler's own lines as `ask_<n>`, evidence only) and `section_split`, each with evidence, candidates, `proposed`, `canTake` and `before` (the section's decision, else the club's active fact; `LAYOUT_FACTS` names the fact keys, the agent's `questions` keep only ids and scope). `frame.layout` takes the decided choice and config as plain input and never asks; the new `frame.split` takes `joins: [{ upper, lower }]` (the finder's proposal stands until it is called). `layoutQuestions`, `splitQuestion`, `splitProposed`, `applyLayoutAnswers`, `joinsFrom`, `delayOf`, `KIND_OPTIONS` and `LayoutReport.ask` are gone (`left` holds the compiler's lines as evidence). `frame.publish` waits until each open item is applied. `settled` (`Settled[]`) is in the tools' results, in frame-match's output (`Result.settled`, `person` kept only when an `ask` of that id was answered in the run) and in its thread note (`threadNote`). Instructions and the skill describe the items and do not script them. Tests: `tests/layout.test.ts`, `tests/tools.test.ts`, `tests/slots.test.ts`, and `tests/open-items.test.ts` (the real agent with a scripted model on a recipe site's rail and a squad strip: the model's `ask` offers every candidate, the answer is applied as input and learned under its id, and the next run settles it by memory with no question). **Not done:** a live run on a Handoff with a carousel and a slot with no data (needs Bedrock and Cast); `pnpm eval frame-match` with the new flow (live; its `responder` approves, so an `ask` there is answered by the proposals); the compiler's `ask` lines for a container that is not a carousel are still the compiler's sentences, handed to the model as evidence (they are in `@fanos/compile`, outside this agent).
