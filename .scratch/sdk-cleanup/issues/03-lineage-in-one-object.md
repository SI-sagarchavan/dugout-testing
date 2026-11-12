# 03 — A child run's lineage as one value

Status: ready-for-agent

`depth`, `parent`, `situation` and `inputHash` are passed one by one through `RunOptions` (sdk), `RunLocalOptions` and `RunContext` (core, contracts), `ToolContext`, and `RunCheckpoint` (`situation`, `inputHash`, `parentCallId`). With `exactOptionalPropertyTypes` each hop is a `...(x ? { x } : {})` spread: about a hundred of them across `packages/sdk/src` and `packages/core/src`.

- One `lineage?: { depth, parent, situation, inputHash }` on `RunContext`, passed whole.
- A `defined()` helper (there is one in `packages/sdk/src/agent.ts`) where a spread only drops `undefined`. Mind the ones that drop `0` or `false` too (`opts.depth ? …`).

No behaviour changes; the tests that exist cover it.
