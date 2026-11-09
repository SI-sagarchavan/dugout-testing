# 05 · frame-match answers with its slots

Status: done (2026-11-09)
Type: task
Blocked by: 02

## What

frame-match still matches and publishes the whole frame as one tree (the background is one). Its
result adds `slots`: for each, `id`, `name`, the DSL node ids it owns (mapped from the IR nodes
through each node's `src`), `content` (none, some, unsure: today's `content.ts`, run per slot, not
per frame), the page choices it writes and those it reads, and a structural signature of its
subtree (for decisions, ADR 0033, and the library).

**Choices belong to their slot** (spec, "Shape"). A choice gets `owner: <slot id>`, and its key
is prefixed with the slot's name (`squad_women_men`, still one `_page` segment, `PAGE_KEY_RE`).
`choices` in the result keeps the owner. `page.ts`'s header comment and ADR 0032 get an amendment:
the page holds every choice, and a choice is read by its own slot unless a cross-slot read was
asked for on purpose (a designer note or a person's answer).

`content` for the whole frame stays, as "some" when any slot is "some", so section-builder's
current skip keeps working until ticket 09.

## Done when

- On Team: two slots, `fixtures` (some) and `squad` (some); one choice, `squad_women_men`, owned
  by `squad`; the fixtures slot reads no choice; the background's nodes in neither.
- Two slots that each draw WOMEN/MEN tabs get two keys.
- On a one-section frame (`LATEST NEWS`): one slot holding every node but the background's.
- Output schema and `schemas/` updated (`pnpm agent schemas`).

## Pointers

- `agents/frame-match/src/agent.ts` (`Result`, `content`, `choices`), `src/content.ts` (`signsOf`)
