# 01. Ask in the harness

Status: done

ADR 0029. Everything in dugout: no other repo changes.

## What

- `@dugout/contracts`: `Question`, `AskInput`, `Answers` (zod); events `question.asked` and `question.answered`; the decision `{ approved: true, by, answers }`; `AwaitingAnswers`, the error a tool throws to ask; `ToolContext.answers`.
- `@dugout/core`: the built-in `ask` tool beside `final`. A call to it, a tool that throws `AwaitingAnswers`, or a child that waits all save the run as waiting with the questions, write `question.asked` and end the invocation. A resumed run hands the answers to the call that asked and writes `question.answered`.
- `@dugout/sdk`: a child that waits stops its parent's call with its questions (`from` grows by the child's run id); the parent's resumed call resumes the child with the answers. A child never answers its own questions (the parent's approval covers writes, not questions).
- `apps/worker`: a decision with answers is queued like an approval (`decide` already takes the decision JSON; check the waiting call matches).
- `apps/cli`: shows each question (a menu for choice and confirm, a checklist for multi, text and number prompts), the proposal preselected, then submits all answers at once. `--yes` answers with the proposals.

## Done when

- A scripted run that calls `ask` with two questions waits, takes the answers, and the model reads them as the tool result; a second round works.
- A tool that throws `AwaitingAnswers` is run again with `ctx.answers` after the answers come.
- A grandchild's question reaches the top run's events and checkpoint; its answers resume the grandchild.
- `pnpm agent attach` on a waiting run asks the questions and submits them.
- `pnpm check` passes for the packages touched.

## Comments

2026-11-06: built. `packages/contracts/src/questions.ts` (shapes, `checkAnswers`, `proposedAnswers`, `AwaitingAnswers`); the loop's `ask` branch, `askPerson`/`settle` and the re-run of a tool with `answered` (`packages/core/src/loop.ts`); child questions passed up and answers down (`packages/sdk/src/subagents.ts`); the CLI asks them (`apps/cli/src/session.ts`). Tests: `packages/core/tests/ask.test.ts`, the grandchild test in `packages/sdk/tests/subagents.test.ts`, two in `apps/cli/tests/session.test.ts` (through a real worker). A yes with no answers takes the proposals.

2026-11-06 (amended): unified. One pause: approvals are a `review` question (ADR 0029 rewritten), `approval.*` events removed, `Approver` -> `Responder`, `Decision` is `{ by, answers? }`, a question is never rejected (decide-for-me, skip, or cancel the run). Learned answers: `answer_memory` (migration 014), `packages/memory/src/answers.ts`, prefill in the loop (`AnswerMemory`), `pnpm agent memory answers`. Fixture: `pnpm fixture waiting-run --tenant <t> [--open ask|review]`.
