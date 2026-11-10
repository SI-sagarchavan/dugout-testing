# 02 · A person can give the feed: `need.sources`

Status: resolved
Type: task
Blocked by: none

## What

Today a feed URL a person gives reaches hook-maker only as free text in `need.hints` (run
`8758c3d4`), and hook-maker cannot tell it from a heading.

- Add `sources` to hook-maker's `Need` (`agents/hook-maker/src/agent.ts`): a list of
  `{ label, url, method? }`, "feeds a person gave for this data; build on them first". `label` says
  which part of the design it is for (`women`, `men`).
- data-bind: when hook-maker answers no hook, or a hook about the wrong team (its `missing` names
  the `must`), ask once, id `data_source`, scope section, with the choices: give the feed (a text
  answer: one URL per line, with a label), bind the closest hook as a stand-in, or leave the slot
  unbound. Declare the question in data-bind's spec `questions`, so the answer is a decision on the
  section (ADR 0033) and the next run on this section proposes it. Put the given URLs in
  `need.sources` on the next `agent.hookMaker` call.
- While here: `count: 0` was sent once and refused (`expected number to be >0`); make the schema's
  description say `"data"` is the value for "whatever the data holds", so the model does not send 0.

## Done when

- `pnpm agent schemas` updated; hook-maker's input schema has `sources`.
- data-bind's skill (`agents/data-bind/skills/bind.md`) says when to ask `data_source` and how its
  answer becomes `need.sources`.
- A test: an answer with two labelled URLs gives a hook-maker call whose `need.sources` has both.

## Pointers

- `agents/hook-maker/src/agent.ts` `Need`, `agents/data-bind/src/agent.ts` (spec `questions`)
- Run `8758c3d4` (the ask `content_mismatch` and its answer) for the shape a person writes
