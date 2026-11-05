# 06 · Search: words, image, both

Status: ready-for-agent
Type: task
Blocked by: 02

## What

`SectionLibrary.search({ text?, image?, kind?, layout?, limit })` over the caller's tenant.

- Rankers: text query against `text_embedding`; text query against `image_embedding` (one space, so words find screenshots); image query against `image_embedding`; full text against `tsv`. Merged by reciprocal rank, as `packages/memory/src/store.ts` does.
- Hidden sections never appear.
- Results carry the section, its crop key, caption, tags and the best source.
- `library.search` and `library.get`: read tools for agents, the tenant from the verified run.
- `pnpm agent library search --tenant <t> "<words>" [--image <path>]` prints the top results with their crop paths.

## Done when

- A test with fixed vectors pins the merged order for words, image and both.
- A query with `kind` returns only that kind.
- The tools take no tenant argument.
