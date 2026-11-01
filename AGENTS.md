# Harness improvements: implementation brief

Written 2026-11-01 from a review of the loop, memory and graph code against the Claude Agent SDK, LangChain/LangGraph and deepagents. Read `CLAUDE.md` too: its rules still apply.

**Goal:** better model results and fewer lost runs, using the architecture already here.

The design decisions below are already made. Implement them as written. If one turns out to be impossible, or conflicts with the code, stop and ask rather than choosing a different design.

## Working rules

- Do the tasks in order, and tick each box when its tests pass.
- Run `pnpm infra:up` first, because tests need Postgres and Valkey. Run `pnpm check` after every task. A task is not done while it fails.
- Write the listed failing test first, then the fix.
- Commit or push only when the user asks. On `main`, branch first.
- **The working tree has unfinished card work that is not yours:** `agents/card/*`, `packages/core/src/model/bedrock.ts`, its test, `packages/sdk/src/agent.ts`, `schemas/card.input.json` and `CLAUDE.md`. Don't revert it, and ask the user how to handle it before the first commit.
- New optional checkpoint fields must stay `.optional()`, so saved runs still load. Don't change `version: 1`.
- The loop stays pure control flow (ADR 0002). No I/O or clock reads in `loop.ts`. Everything goes through `steps`, `log`, or a value passed in.
- Every model must still get one tool result per tool call.
- Don't add anything listed under "Not in this work".
- Keep the repo's code style: short comments that explain why, zod at boundaries, no new dependencies.

## Before you start: baseline

Run this before any harness change. It uses live Bedrock and costs money. If AWS credentials fail, stop and ask the user.

```
pnpm eval match-preview
pnpm eval sitemap
pnpm eval matchday
pnpm eval card
```

Record each suite's pass rate and cost under "Results" at the end of this file. Run them again after Part 2 and after Part 3.

## Part 1: bugs (reproduced)

### [x] 1. Handle stop reasons

**Problem:** `loop.ts:438` never reads `turn.finishReason`. A reply cut off at `max_tokens` currently ends as `completed` with `"The match begins at"`. Content filter and guardrail stops also end as `completed`.

**Change:**

- Add `"model_stop"` to `FailureReason` (`loop.ts`) and to the `run.failed` enum (`packages/contracts/src/events.ts:113`).
- After the budget check, in the `!state.turn` block:
  - **Terminal:** `guardrail_intervened`, `content_filtered`, `model_context_window_exceeded`, `refusal`. Call `fail("model_stop", ...)` and name the stop reason in the message. Don't run any tool calls from that turn.
  - **Recoverable:** `max_tokens`, `malformed_tool_use`, `malformed_model_output`. Increment `state.invalidOutputs`, and past `MAX_INVALID_OUTPUTS` call `fail("model_stop", ...)`. Otherwise:
    - With tool calls: set `turn.cutOff = true` (new optional checkpoint field). In `answerTurn`, every call goes through `skip()` with `Not run: your reply was cut off (<reason>). Send it again, shorter.` Never run a call from a cut-off turn, even one whose JSON parses.
    - Without tool calls: push a user message saying the reply was cut off and asking for a shorter one, then save and continue.
- Any other value (`end_turn`, `tool_use`, `stop`, `tool_calls`, `stop_sequence`) behaves as it does today.

**Tests (`packages/core/tests/loop.test.ts`, using `createScriptedModel` with `finishReason`):**

- `max_tokens` with no output schema retries, then completes on the next good turn.
- Three cut-off turns in a row end as `failed` with reason `model_stop`.
- A cut-off turn containing a write tool call never reaches approval or the tool.
- `content_filtered` fails at once, and its tool calls don't run.

### [x] 2. Don't accept `final` after a failed call, and add `verifyFinal`

**Problem:** at `loop.ts:253`, when `pack.save` fails and `final` comes in the same turn, the run completes even though nothing was saved.

**Change:**

- Add optional `turn.failed` (the tool name) to the checkpoint. Set it wherever a call in this turn is denied, returns `ok: false`, or gets `UNKNOWN_OUTCOME`.
- At `final`: if `turn.failed` is set, increment `invalidOutputs` (past the limit, fail with `invalid_output`). Otherwise `skip()` with `Not accepted: <tool> failed in this turn. Deal with that before calling final.`
- Add to `AgentDefinition` (`packages/contracts/src/spec.ts`) and `AgentConfig` (`packages/sdk/src/agent.ts`):

  ```ts
  verifyFinal?: (output: unknown, run: { ctx: RunContext; messages: Message[] }) => string | undefined;
  ```

  It is synchronous and has no I/O, like `Tool.block`. Run it after the schema check passes, on the unwrapped value. A returned string becomes the tool result `Not accepted: <string>`, and counts against `invalidOutputs`.
- Don't wire `verifyFinal` into any agent in this work.

**Tests:**

- A failed write plus `final` in one turn doesn't complete, and the model is called again.
- `final` in the next turn completes.
- `verifyFinal` refuses, then accepts.

### [x] 3. Retry transient model errors, and let the worker pick up the rest

**Problem:** the harness has no retry. `loop.ts:472` turns any model error into a terminal `failed`, so the worker's retry path never sees it and a saved run is lost.

**Change:**

- New file `packages/core/src/model/errors.ts`: `export class TransientModelError extends Error {}`. Export it from `packages/core/src/index.ts`.
- `bedrockError` (`bedrock.ts`) returns `TransientModelError`, keeping `cause`, when the name is one of: `ThrottlingException`, `ServiceUnavailableException`, `InternalServerException`, `ModelStreamErrorException`, `ModelTimeoutException`, `ModelNotReadyException`. Check that in-stream failures thrown from `readStream` carry that name, and use the fake `runtime` in `bedrock.test.ts` to prove it.
- `createLocalSteps.model`: retry only `TransientModelError`, up to 3 more attempts, waiting 1s, 2s and 4s with ±25% jitter. Add a `retryDelayMs?: (attempt: number) => number` option so tests don't sleep. Build new fragments per attempt. Duplicate live `token` events on a retry are acceptable.
- `loop.ts` catch: if `err instanceof TransientModelError && steps.checkpoint`, rethrow it. The worker then records `last_error`, the lease runs out, and the run resumes from its save, up to `maxAttempts`. Without a checkpoint store, call `fail("error", ...)` as today.

**Tests:**

- Bedrock: a throttle maps to `TransientModelError`, and a validation error doesn't.
- Local steps: two throttles then success completes the run with one `step.completed`.
- Validation errors aren't retried.
- `apps/worker/tests/worker.test.ts`, following "pick up a run whose worker died": a run whose model keeps throwing transient errors resumes and finishes when the model recovers.

### [x] 4. Resume a graph from where it stopped

**Problem:** `defineGraph` (`program.ts:287`) walks again from `start` on resume, using the latest state and restarting visit counts. It can land on an already finished visit id and silently skip work.

**Change:**

- Add `cursor?: unknown` to `ProgramCheckpoint`.
- Add to `ProgramContext`: `cursor<T>(): T | undefined` and `setCursor(value: unknown): Promise<void>`, which saves.
- In `defineGraph.run`, the cursor is `{ node: string | null; visits: number; seen: Record<string, number> }`. Set it **before** running each node, with `seen` already including that visit, and set `node: null` when the walk ends.
- On start, carry on from a saved cursor. A crash after a node finished but before the next `setCursor` is safe: the node's id is in `done`, so it is skipped, and the edge is evaluated on the state it just wrote.
- A checkpoint with no cursor (an older file, or a hand-built test checkpoint) falls back to today's walk from `start`.
- The new saves can change how many times `save` is called. Update existing tests only if they count saves.

**Test (`packages/core/tests/program.test.ts`):** a graph with nodes `check`, `repair` (task with `apply`) and `save`, and these edges:

- `check` to `repair` when `!checkOk`, otherwise to `save`
- `repair` to `check`
- `save` to `END` when `passed`, otherwise to `repair`

`check` passes when `tree !== "v0"`. Run it like this:

1. First run: `save` answers "make the title bigger", and the task throws on `repair#2`.
2. Resume with `save` answering approve.

Today this fails: `repair#2` never reruns, the tree stays `v1`, and `changes` stays set. Required result: `repair#2` reruns with that change in its input, `save#2` sees the new tree, `repairs` is 2 and `changes` is `""`.

### [x] 5. Show repair its failures and past attempts

**Problem:** `repairInput` (`agents/card/src/program.ts:157`) leaves out `state.error`. A failed edit batch gets the same report again, with no record of what was already tried.

**Change (card only):**

- Add to `CardProgramState`: `attempts: Array<{ repair: number; stage: string; report: string; edits: string; result: string }>` with `reduce: "append"`.
  - `report` is clipped to 300 characters.
  - `edits` is a compact summary clipped to 300, such as `node_1: props padding, color`.
  - `result` is `applied` or the apply error.
  - Add the entry in `applyRepair`.
- Add `lastError` and `attempts` (the latest 5) to `RepairInput` and to its zod schema in `repair.ts`.
- Add to the `card-repair` instructions: `attempts lists what you already tried. Do not send an edit that already failed. lastError says why your last edits were not applied.` Bump that spec's `version`.
- No-progress stop: in `check` and `diff`, if the new report equals the report of each of the last 2 attempts, set `halt: true` and `error: "repair is not changing the result"`. `diff` already has an `END` edge on `halt`. Add the same edge for `check`, placed before its other edges because the first match wins. The `check` step currently resets `halt` to false, so remove that reset for this case.

**Tests (`agents/card/tests/program.test.ts`):**

- A repair that names a missing node makes the next repair's input carry `lastError`.
- Reports that never change stop the graph before the attempts run out.

## Part 2: loop

### [x] 6. Warn before the step limit, and force `final` when it matters

- At the top of the loop, when `state.turn` is unset and `maxSteps - state.step === 2`, push one saved user message: `2 model turns left. Finish now.`, followed by `Call final with your result.` when the agent has an output schema. Guard with an optional `state.stepsWarned`. Save it in the transcript, not only in the request, so a resume or fork sends the same request (ADR 0016).
- Add `toolChoice?: { tool: string }` to `ModelRequest` and `ModelStepRequest`, and a per-model `forcedTools` boolean to `ModelEntry`, default false, following `strictTools`. Bedrock sends `toolConfig.toolChoice = { tool: { name } }`.
- The loop asks to force `final` on the last allowed step and on the turn after a "Call the final tool" nudge. `createLocalSteps` drops the field when the model's `forcedTools` is false.
- **Live check before turning it on:** from a throwaway script in the scratchpad, call `haiku` and `sonnet` with `toolChoice` and their configured effort. Forced tools may conflict with reasoning. Set `forcedTools: true` in `config/models.json` only for models that accept it, and leave Nova off. Record the outcome in the Results section.

**Tests:** the warning appears exactly once. The last-step request carries `toolChoice` only for a model with the flag on.

### [x] 7. Stop repeated failing calls

- Add optional `state.failedCall: { tool, args, count }` to the checkpoint, using `stableArgs`. Increment it on an identical `ok: false` outcome, and clear it on any successful tool call. At `count === 3`, emit the tool result and `fail("invalid_output", "<tool> failed 3 times with the same input")`.
- Move the in-memory `refused` variable into the checkpoint as optional `state.refused`, so a resume keeps it. Its behaviour doesn't change.

**Tests:** the same failing call ends the run at the third try, not at `maxSteps`. A different input or a success resets the count.

### [x] 8. Mark failed tool results as errors

- Add `isError?: boolean` to `ToolMessage` (`packages/contracts/src/messages.ts`). Set it in the loop for denials, `ok: false`, invalid `final`, refused `final`, skipped calls and `UNKNOWN_OUTCOME`.
- Add a per-model `toolErrorStatus` boolean, default false. When on, Bedrock's `toolResult` gets `status: "error"`.
- **Live check:** AWS docs list this field for Nova and Claude 3 and 4 only. Try a two-turn call on `haiku`, `sonnet` and `nova-lite`, and set the flag only where it is accepted. Record the outcome.

## Part 3: memory

### [x] 9. Store approved outputs as examples, and drop "Similar past runs"

**Problem:** run records tell the model only `Input {...}: completed.`, which is no use to it.

**Change:**

- Migration `011_example_episodes.sql`: allow `example` in the `episode_type` check, replacing the constraint from `005_episodes.sql`. Add `"example"` to `EpisodeType`.
- `consolidateRun`: if the run ended `completed` and a write tool had `approval.granted`, add one `example` episode from the **last** approved call's input. Content is `<tool>: <redacted JSON>`, `situation` is the run input, `confidence` is 1 and the TTL is `EPISODE_TTL_DAYS`. Skip it if the content is over 4,000 characters.
- `buildContext`: recall at most 2 examples, under the heading `## Approved examples`, with this text: `Past work an editor approved. Use it for style and structure only. Never copy its facts, names or numbers.`
- Remove the `## Similar past runs` section from `buildContext`. Keep writing run records. Update `memory.test.ts:528`.
- `store.search`: leave out `example` episodes. `shared.ts` already only promotes lessons, so don't change it.
- Redact `content` and `situation` for every episode in `consolidateRun`, using `createRedactor` from `@dugout/core`.

**Tests:**

- An approved write stores an example that later appears in the context.
- A rejected run stores none.
- An email in the input doesn't reach stored text.
- `memory.search` returns no examples.

### [x] 10. Rank lessons, and promote repeated ones

**Problem:** `recallEpisodes` (`store.ts:216`) orders only by cosine similarity, against text as thin as `{"fixtureId":"c-101"}`. `strength` has no effect.

**Change:**

- For `episodeType: "lesson"`: fetch up to 20 rows above `MIN_EPISODE_SIMILARITY`, **plus** live lessons with `strength >= 3` at any similarity. Rerank in TypeScript by:

  ```
  similarity + 0.05 * min(strength - 1, 4) + 0.05 * exp(-ageDays / 60) + (agentId matches ? 0.05 : 0)
  ```

  where `ageDays` uses `lastSeenAt`. Return the top `limit`. Export the weights as named constants, and fix the doc comment at `store.ts:58`.
- In `consolidateRun`: when `addEpisode` returns `reinforced: true` and `strength === 3`, call `proposeFact` with key `lesson.<first 8 hex of sha256(content)>` and the lesson as its content, unless that key already exists (check with `history`). Content over 500 characters is clipped. A person still approves it through `pnpm memory:review`.

**Tests:**

- Of two equally similar lessons, the stronger comes first.
- A strength-3 lesson with low similarity is recalled.
- The third repeat creates exactly one proposal, and the fourth doesn't create another.

### [x] 11. Separate stable and recalled memory, and cap recall

**Problem:** recalled memory sits in the system prompt before the only system cache point, so runs with different recalled memory share no cached prefix. It also gives recalled text system-level trust. Separately, the 12% budget is 120,000 tokens on a 1M model, so it never limits anything.

**Change:**

- Add `recalled: string` to `RunMemoryContext`.
- `buildContext`: `text` holds instructions-level material only (skills, the skill listing, house facts, shared facts). `recalled` holds:

  ```
  <recalled_memory>
  Today is <YYYY-MM-DD>.

  ## Lessons from past runs
  ...
  ## Approved examples
  ...
  </recalled_memory>
  ```

  Date comes from a `now` option defaulting to the real clock, because the context builder runs outside the loop.
- `loop.ts:117`: the first user message is `recalled`, a blank line, then the input, when `recalled` is non-empty. Otherwise it is the input alone.
- Add `recalledBudgetTokens` (default 6,000), applied to lessons and examples. Add `factsBudgetTokens` (default 6,000), applied to house and shared facts. Don't count skills against either. Skills keep today's budget and error.
- Change "the lessons below" to "the lessons in the recalled memory" in `agents/sitemap/src/agent.ts:20`, `agents/match-preview/src/agent.ts:18` and `agents/matchday/src/agent.ts:22`, and bump each `spec.version`.
- Update tests that look for lessons in `messages[0]`: `agents/match-preview/tests/agent.test.ts:188` and `:198`, `agents/matchday/tests/agent.test.ts`, `agents/sitemap/tests/agent.test.ts`, and `packages/sdk/tests/agent.test.ts`. Check any eval suite that inspects the system prompt.

**Tests:**

- Two runs of one tenant with different inputs send an identical `messages[0]`.
- Lessons appear in `messages[1]`, and the input is still intact there.
- Lessons stop being added at the cap.

### [x] 12. Add a relevance floor to `memory.search`

In `store.ts:173`, return a row only if it matched the text search or its cosine similarity is at least `MIN_EPISODE_SIMILARITY`. Test: a query unrelated to everything returns `[]` with the hash embedder.

## Part 4: documents

### [x] 13. Record it

(docs done; evals run once after all changes, see Results)

- New `docs/adr/0018-stop-reasons-retries-and-finishing.md`: tasks 1, 2, 3, 6, 7 and 8, including the live-check results.
- Update ADR 0017 for the cursor (task 4).
- Update ADR 0013: examples, ranking, promotion, recalled memory, and the removed run-record section. Mark as **not yet built**: compaction and notes (memory 04), the after-run extractor, pinned facts and the similar-fact check on proposals (memory 03), and skill suggestions (memory 05). The ADR currently reads as though they exist.
- Update `CLAUDE.md` only where a described behaviour changed. The user has uncommitted edits there, so make small edits.
- Run the evals again, fill in the Results table and tell the user which changes moved the numbers. Say plainly if something got worse.
- When the user has reviewed the results, ask whether to delete this file.

## Not in this work

These were reviewed and deliberately deferred. Don't build them.

- Compaction, tool-result clearing and `beforeModel` middleware. Current agents run 12–16 steps on 1M windows, so they wouldn't benefit yet.
- Virtual filesystem, shell, `write_todos`, generic or model-led subagents. Leave `maxDepth` at 0.
- Parallel read-only tools. It saves time rather than improving quality, and complicates durable ordering.
- Agents writing long-term memory directly. A person always approves facts.
- A graph interrupt primitive, hosting programs in the worker, a shared program budget, a fold step on `map` nodes, and `until` retries that change their input. These belong to issue 04.
- A model judge step before approval. Add it only if the evals show editors rejecting work the graders pass.
- Richer lesson search text and ticket 03's pinned facts. Decide these from eval data.

## Results

Part 2 and Part 3 were evaluated together, once, after every change was in (not separately). Baseline is HEAD 9bcfaa1 (the user's uncommitted card work excluded). Each suite repeats its cases 3 times, so a difference of one or two attempts is noise.

| Suite                     | Baseline                         | After all changes                |
| ------------------------- | -------------------------------- | -------------------------------- |
| match-preview (nova-lite) | 55/102, 54%, $0.0564, judge 3.88 | 54/102, 53%, $0.0651, judge 3.76 |
| sitemap (haiku)           | 37/39, 95%, $0.0635, judge 4.13  | 37/39, 95%, $0.0632, judge 4.20  |
| matchday (haiku)          | 7/12, 58%, $0.0254               | 8/12, 67%, $0.0262               |
| card (1 case)             | 3/3, 100%, $0.0083 on haiku      | 3/3, 100%, $0.1103 on sonnet     |

The card rows are not comparable: the baseline lacks the user's uncommitted card changes, which also switched the agent to sonnet.

Reading: the harness changes did not move the pass rates. The failures are the same cases as before (match-preview word-limit overruns of 121-144 words against 120, missing `draft.save`, invented numbers; matchday venue name and approvals count), so they come from the model and the prompts, not from the loop. The suites read memory, so the recalled block runs in them, but eval runs do not write memory, so approved examples and lesson promotion are covered by unit tests only.

Extra run: `pnpm eval match-preview --model haiku` gave 15/102 (15%), $0.1098, judge 4.10. A stronger model does not fix match-preview: the graders fail mostly on `word-limit` (95-147 words against limits of 80 and 120) and on `kickoff-time`, while the judge scores it higher than nova-lite. Next lever: make `draft.save` refuse an over-limit draft with the count in its error (Anthropic's advice on actionable tool errors), so the model rewrites instead of guessing at word counts. Not built.

Live checks:

- `forcedTools`: checked 2026-11-01 on si-main. Accepted by `haiku` (low effort) and `sonnet-india` (medium), so both are `true`. Refused (`tool_choice: type "tool" and "any" are not supported for this model`) by `sonnet`, `sonnet-deep` and `opus` (the `global.*-5-5` ids), with or without effort, so they stay off. `opus-india` and the Nova entries were not tried; they stay off.
- `toolErrorStatus`: checked 2026-11-01 with a two-turn call (tool call, then a result with `status: "error"`). Accepted by every entry in `config/models.json` (haiku, sonnet, sonnet-deep, opus, sonnet-india, opus-india, nova-micro, nova-lite, nova-pro, nova-2-lite), so it is `true` on all of them.
