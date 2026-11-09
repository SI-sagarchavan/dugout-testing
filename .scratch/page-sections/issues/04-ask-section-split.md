# 04 · Ask a person when the split is unsure, and remember it

Status: ready-for-agent
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
