# 09 · section-builder binds each slot, merges, publishes once

Status: done (2026-11-09): live check on Team passed, run `bf0b30f6`, both slots bound (spec, "Live check")
Type: task
Blocked by: 05, 06, 07, 08

## What

`page.build` becomes:

1. `frame-match` once (the whole band, as today), answering `slots`.
2. Slots with `content: none` are left as published.
3. For each other slot, `bind` with `{ preview, slot }`, keyed by the slot's id (ticket 06), two at
   once at most. Hook look-ups are read-only; a slot that needs a hook built waits for the one
   approval of the pass (or `--yes`), and builds run one at a time.
4. Code merges the slots' plans (refuses overlapping nodes), checks the merged plan over the merged
   bag (`bind.try`'s checks, run in code), and publishes once: one preview, one plan, one data map
   with every slot's source (ticket 08).
5. A slot that failed three times is reported in `remaining` with its name; the others are still
   published.

Before starting, count the Cast live runs the pass may spend; stop with a clear message when it
would go past what is left of the hour's 25.

Output: today's fields plus `slots: [{ name, data: bound | none | failed, hookId, bound,
collapsed, remaining }]`; `threadNote` names each slot.

## Interim, before 05–08 land

The baseline (spec) shows bind choosing one data area and saying nothing about the other. Until the
fan-out exists, `bind.try` (or `bind.publish`) lists each repeat group with placeholder copy that the plan
doesn't touch, as `remaining: "data: <slot heading> is not bound: one data source per run"`, so
the person sees the gap. Small, and it can ship on its own.

## Done when

- Live run on Team (export `1b10c408-…`): one preview with fixtures and squad both bound, the
  WOMEN/MEN tabs filtering the squad cards, the background as designed. Compare with the baseline in
  the spec.
- A one-slot frame behaves as today (same output, `slots` of one).
- `section-builder`'s eval (or a new case) covers a two-slot frame with the fake Cast hub.

## Pointers

- `agents/section-builder/src/agent.ts` (`pipeline`, `assemble`), `@dugout/mcp/testing`

## Follow-ups (review, 2026-11-09)

- **The budget guard uses `NeedsSetup`, which isn't what it's for.** CLAUDE.md keeps `NeedsSetup` for "a sign-in, a key": the run ends `needs setup: …`, and Studio and the CLI show it as a setup problem. Running past the budget isn't a setup problem. The estimate is also fixed (6 runs per slot), so a page of 5 slots with data always stops, even when every hook already exists and a look-up costs 1–2 runs. Better: ask a person once (`cast_budget`: "this pass may use about N of Cast's 25 live runs this hour", with the choices bind all, bind the first K, or stop), and lower the estimate for slots whose hook a decision already names (`before`).
- **The steps budget is tight.** A failed slot fails the whole `page.build`, so the model calls it again. With `maxSteps: 8`, two failed tries of frame-match plus two each for two slots, then success and `final`, is exactly 8. Raise it to 12, or count tries per slot in code.
- **Concurrency is 1.** Read-only hook look-ups could run in parallel while builds stay one at a time. That's worth doing when ticket 10 brings pages of 4+ slots, not before.
- **No eval case with the fake Cast hub.** Add a two-slot case (Team) to the section-builder eval, so the fan-out is measured without Cast.

## Follow-ups done (2026-11-09)

- Budget: no `NeedsSetup` any more. When the slots with data could spend more than an hour of
  Cast (6 runs a slot, 25 an hour), the pass asks once, `cast_budget`: bind the first 4 (proposed),
  all, or none. Slots not bound are `skipped` in `slots` and listed in `remaining`. A pipeline can
  now stop for a person itself: `Pipeline.run` gets `own.answered`, the answers to its own questions
  (`packages/sdk/src/subagents.ts`, test `packages/sdk/tests/pipeline-answers.test.ts`).
- `maxSteps` 8 → 12.
- Not done: lowering the estimate for a slot whose hook a decision already names (the pass would
  read the data-bind decisions from memory: worth it when pages bring 4+ slots); concurrency stays 1.
- Not done: an eval case. section-builder and data-bind have no eval suite; a two-slot case needs
  a scripted harness over frame-match, data-bind and hook-maker with the fake Cast hub. The fan-out
  is covered by `tests/fan-out.test.ts` with faked children.
