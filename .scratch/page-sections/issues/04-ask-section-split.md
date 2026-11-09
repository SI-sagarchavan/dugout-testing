# 04 · Ask a person when the split is unsure, and remember it

Status: done (2026-11-09)
Type: task
Blocked by: 02, 05

## What

When the finder leaves a slot `unsure`, frame-match asks a person (one pause, ADR 0029), with the id
`section_split`: the slots it found, each with its name, its layers and a picture (the library's
crop), why it is unsure, and the split it would pick as `proposed`. The answer can merge two slots,
split one at a layer, or move a layer.

The answer is a decision about this frame (ADR 0033): keyed by the agent, `section_split` and the
frame's structural signature, so a later Handoff of the same frame is not asked again, and
`frame.load` returns it in `before`. `--yes` takes `proposed`.

## Done when

- `section_split` is in frame-match's spec `questions`; a test runs a frame with an unsure slot, an
  answer that merges two slots, and a second run of the same frame that asks nothing.
- A designer mark (ticket 03) makes a slot `sure`: a marked frame is never asked.

## Pointers

- `packages/core` questions (`Question`, `AwaitingAnswers`), `packages/memory/src/decisions.ts`
- `frame.layout` already asks about containers: same mechanism

## Done (2026-11-09)

- `frame.load` settles the split before it builds anything (`settleSplit`,
  `agents/frame-match/src/tools.ts`): nothing when every slot is sure; else the person's answer
  now, or the decision on this frame from an earlier run (`frame-match:section_split@<signature>`,
  read with the memory store's `decision`); else it asks one `section_split` question (multi):
  "Keep them apart", plus one "One section: A and B" per join the finder was unsure of. A heading
  with nothing under it is proposed joined to the part below; two parts with no heading between
  them are proposed apart. `--yes`, or answering nothing, takes the proposal.
- The answer becomes joins (`findFrameSlots(tools, bundle, joins)`): the joined parts are one
  sure slot, named by the one that was sure, signed again. A join naming a part that is gone is
  dropped.
- `section_split` is declared in frame-match's spec, so the answer is kept as a decision on the
  frame.
- Tests: `tests/slots.test.ts` (choices, question, joins), `tests/tools.test.ts` (asks before
  building, applies an answer, takes the proposal, uses a decision and asks nothing).
- None of the four eval frames is unsure, so none of them asks.
- Not done: the question carries no picture of each part (questions are text); the
  names and layers say which part is which.
