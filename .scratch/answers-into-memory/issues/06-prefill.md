# 06 · Prefill and answering from memory

Status: resolved
Type: task
Blocked by: 02, 03, 04

## What

Replace `createAnswerMemory` (`packages/memory/src/answers.ts`) with `createDecisionMemory`, behind the same `AnswerMemory` interface the loop calls (`refine`, `answer`; `packages/core/src/loop.ts`), wired in `packages/sdk/src/agent.ts`.

- `refine`: for each declared question, the first that fits the question's kind and options:
  1. the decision on this section (`<agent>:<id>@<section>`),
  2. the active fact named by `fact`,
  3. the proposed fact named by `fact`.

  It becomes `proposed`, and `learned` says `{ from: "decision" | "fact", times, lastAt }`.
- `answer`: answers without asking only when every question has an active fact that fits, and no decision on this section differs from it. `source: memory`.
- `Learned` in `packages/contracts/src/questions.ts` gains `from`. Hosts that mirror it (wnm-fanxp-backend, Surface Studio's queue card) show "decided on this section" and "house fact" apart.

## Done when

- Loop tests: a same-section decision prefills; a fact prefills when there is no decision; an active fact answers; a differing decision stops that and asks; an undeclared question is untouched.

## Comments

2026-11-08: `createDecisionMemory` (`packages/memory/src/decisions.ts`) behind the loop's `AnswerMemory`, wired in `packages/sdk/src/agent.ts`; `Learned.from` (optional, so hosts keep working); the terminal says where a proposal came from (`learnedLine`, `apps/cli/src/session.ts`). The FanXP backend and Studio's queue card do not show `from` yet.
