# 04 — Context budgets that bind

Status: ready-for-human

From a read-only audit on 2026-11-10 (spot-checked: every agent's model has a 1M window in `config/models.json`; seven tools set `alwaysInline`). Check each line reference before acting on it.

- **Compaction never runs.** It starts at 65% of the model's window (`COMPACT_AT`, `packages/core/src/compact.ts`). Haiku and Sonnet have 1M, so that is 650k tokens, which a $1 to $3 run never reaches. `MEMORY_SHARE` (12% of the window) is 120k tokens, so the "skill must fit" check never fires either; only the fixed 6k caps bind. Fix: an absolute threshold, `min(0.65 × window, N)`, from the last step's real `usage.inputTokens` rather than an estimate.
- **The largest results skip the 16,000-character limit.** `alwaysInline` is on `frame.load`, `frame.override`, `frame.layout`, `frame.split`, `bind.load` and `bind.source`. Each `frame.override` result supersedes the last and all stay in full. Fix: a "latest only" flag, with earlier results elided at the next turn.
- **When compaction does run, the summary is written from stubs.** Results over 2,000 characters become a 300-character preview before the summariser reads them, so it never sees `before`, `built`, `lessons` or the open items of a load result. Fix: summarise from the whole messages, or exempt load results. What `final` needs is safe either way now (run state, ADR 0035).
- **Four token estimators**: chars/4 in `memory/src/context.ts`, inline in `memory/src/index.ts` and `built.ts`; chars/3.5 in `core/src/compact.ts`. Core and memory both export `estimateTokens` with different signatures. One exported estimator.
- **Caps that leak**: a thread's "What exists now" and "Left open" lines are added before the 1,500-token budget is applied (`memory/src/thread.ts`); `patterns` is uncapped in frame-match and hook-maker (data-bind slices to 20). MCP guidance in the system prompt is uncapped.

Sound, leave alone: stable memory in the system prompt, the input-dependent part in the first user message, the transcript last, with cache points after the system prompt and on the newest turn; the transcript only grows and compaction is a view of it.

## Comments

2026-11-11 (ADR 0036): done: the token cap on compaction, sized by what the model counted; the summary from whole turns; `latestOnly` on `bind.try`, `ui.try`, `frame.override`; the thread's state lines in its budget. Left: `frame.layout`, `frame.split` and `bind.source` keep every result (a source's result is not replaced by another source's); one token estimator; `patterns` uncapped in frame-match and hook-maker; MCP guidance uncapped.
