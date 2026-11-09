# 07 · bind works on one slot's nodes

Status: done (2026-11-09)
Type: task
Blocked by: 05

## What

`bind`'s input takes an optional `slot: { id, name, nodes }` (from frame-match's `slots`). With it:

- `bind.load`'s outline, "what repeats", placeholders and designer notes cover only the slot's
  nodes; its choices and `links` are only the ones the slot owns (the squad's cards link to
  `_page.squad_women_men`; the fixtures, whose items carry WOMEN/MEN too, get no link), plus a
  choice from another slot only when a designer note or a person's answer says to read it;
- `bind.try` reports a `when` that reads a choice the slot doesn't own and wasn't given;
- `bind.node` refuses a node outside the slot; `bind.try` checks and lists problems for the slot's
  nodes only (no "placeholder in every card" about the other section);
- the plan it writes touches only the slot's nodes;
- `agent.hookMaker`'s `need` is the slot's (its heading and labels as hints);
- `bind.source`'s `as` defaults to the slot's name;
- decisions it asks about (`card_template`, `choice_filter`…) are keyed by the slot's signature, not
  the frame's.

`bind.publish` is not called for a slot that is part of a pass (ticket 09 publishes once); a new
tool or a flag makes it answer the plan instead (`bind.done`), checked as today.

No slot: today's behaviour.

## Done when

- A test with the Team preview and a `squad` slot: outline without the fixtures cards, a plan over
  squad nodes only, `bind.node` on a fixtures node refused.
- A test with the `fixtures` slot: no choice listed and no link, though its items hold "Women" and
  "Men"; a plan with `eqPath: "_page.squad_women_men"` is reported by `bind.try`.
- The data-bind skill says what a slot is, in two lines.

## Pointers

- `agents/data-bind/src/tools.ts` (`frameOf`, `loaded`, `bind.load` ~777, `bind.try` ~905), `src/dsl.ts`, `skills/bind.md`
