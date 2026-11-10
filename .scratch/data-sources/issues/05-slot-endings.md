# 05 · A slot ends bound, stand-in or none, never by failing

Status: resolved
Type: task
Blocked by: none

## What

Two gaps, seen in run `3acd204c`:

1. **No legal way to end a slot without data.** With no source, `final` is refused ("Nothing was
   published") and `bind.done` with `despite` is refused ("Nothing to publish. Call bind.try with a
   plan first"), so the run fails `invalid_output` and `page.build` fails with it. 22 of 26 failed
   data-bind runs in two weeks ended this way.
2. **Wrong data reported as bound.** A hook about another team is bound and the slot says
   `data: "bound"`, in `page.build`'s output and in the thread note.

Changes:

- data-bind: `bind.done` (slot) and `bind.publish` (frame) accept `{ none: "<why>" }` with no plan:
  the slot keeps the design's copy, and the run completes with `data: "none"` and the reason. The
  `final` refusal message names it.
- data-bind output gets `data: "bound" | "stand-in" | "none"`. `stand-in` is set by code, not the
  model: when the source's `missing` (hook-maker's answer) names the need's `must` (team,
  competition), or the person chose "bind the closest hook" (ticket 02's question).
- section-builder: `SlotOutput.data` and `Output.data` take `stand-in`
  (`agents/section-builder/src/agent.ts:66,83`); the thread note and the printed summary say
  "bound to stand-in data (<why>)", and Surface Studio can show it (an enum value in the schema).

## Done when

- A data-bind test: hook-maker answers `hookId: null` → the run completes, slot `none`, no
  `invalid_output`.
- A section-builder test: one slot `stand-in`, one `bound` → output and thread note say so.
- `pnpm agent schemas` updated.

## Pointers

- `agents/data-bind/src/agent.ts:238` (the refusal), `agents/data-bind/src/tools.ts` (`bind.done`,
  `bind.publish`, `despite`), `agents/section-builder/src/agent.ts` (`oneSlot`, slot merge, note)
