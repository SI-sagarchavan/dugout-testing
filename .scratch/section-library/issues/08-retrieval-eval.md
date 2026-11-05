# 08 · Retrieval eval

Status: ready-for-agent
Type: task
Blocked by: 05, 06

## What

`pnpm eval library`: cases of a query (words, an image, or both) and the sections that should come back, over the eval frames indexed into a test tenant.

- At least 30 cases: plain names ("standings table"), described structure ("cards with two crests and a score"), and image queries from crops of other frames and from outside screenshots.
- Reports recall@5 and MRR for each kind of query; gates on recall@5 like the other suites' pass-rate gate.
- `--model` runs it with another embedding model, so ticket 01's choice can be compared here.

## Done when

- The suite runs in CI with the hash embedder (lexical only, a low gate) and live with the chosen model (the real gate), and the numbers are recorded in `spec.md`.
