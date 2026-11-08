# 01 · ADR 0033, CLAUDE.md

Status: resolved
Type: design
Blocked by: —

## What

`docs/adr/0033-answers-are-facts-or-decisions.md`: the decisions table in `../spec.md`, as an ADR. It supersedes ADR 0029's "Learning from answers" section (Learn, Prefill, Stand) and leaves the rest of 0029 (one pause, typed questions, `review`, events, decision shape) as it is.

- Context: the Nov 7 / Nov 8 runs, the three stores, matching by wording, `hash-v1`.
- Decision: facts and decisions, declared question ids, the section signature, prefill order, answering only from an active fact, promotion at three sections, the tools that return earlier decisions.
- Consequences: `answer_memory`, `answers.ts`, `pnpm agent memory answers` and `standing` go; `Learned` gains `from`; hosts that mirror `AskedQuestion` (wnm-fanxp-backend, Surface Studio) take the new `learned` shape; the 19 `sb` rows move (ticket 09).
- Sources: CoALA (arXiv 2309.02427), LangChain memory concepts, LangMem conceptual guide, AWS AgentCore memory strategies.

Mark ADR 0029's section "Superseded by ADR 0033". In `CLAUDE.md`, rewrite the sentence in `packages/core` that starts "What people answered is learned" and the `packages/memory` line.

## Done when

- The ADR is written and a person has read it; 0029 points to it; `CLAUDE.md` says where answers go.

## Comments

2026-11-08: `docs/adr/0033-answers-are-facts-or-decisions.md`; ADR 0029's "Learning from answers" marked superseded; `CLAUDE.md` (`packages/core`, `packages/memory`, Commands) says where answers go.
