# 06 · Search: words, image, both

Status: in progress
Type: task
Blocked by: 02

## What

`SectionLibrary.search({ text?, image?, kind?, layout?, limit })` over the caller's tenant.

- Rankers: the words query against the words vector, and against the picture vector when the model puts both in one space; the picture query against the picture vector, and against the words vector likewise; full text over `search_text`. Each reads at most 50; merged by reciprocal rank.
- Hidden sections never appear.
- `library.search` and `library.get`: read tools for agents, the tenant from the verified run.
- `pnpm agent library search --tenant <t> "<words>" [--image <path>] [--kind <k>] [--layout <l>]` prints the top results with their picture paths.

## Done when

- Tests pin the order for words, a picture, and filters.
- The tools take no tenant argument.

## Comments

2026-11-06: `SectionLibrary.search` is in, with tests for words, picture, filters, hidden and tenancy (`packages/library/tests/store.test.ts`). Left: the agent tools and the terminal command.

2026-11-06: `pnpm agent library search` is in. Left: the agent tools.
