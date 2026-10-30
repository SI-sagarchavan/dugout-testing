# 07 · Reuse approved subtrees

Status: needs-triage
Type: design + task
Blocked by: 01, harness 06

## What

When a reviewer approves a run, save each repaired subtree under its DSL subtree signature, per tenant. Before repairing anything, a code step looks up the subtrees in the new selection. A match means the approved subtree is reused, with this selection's data, and no task runs for it.

To settle:

- what counts as a match: exact signature only, or also near matches
- whether a reused subtree can still be overridden when its render fails
- where the table lives: dugout's database, or the FanOS control plane
- how to forget a mapping that turned out wrong

## Why

It's the main guard against recreating what already exists. Each approved page makes the next one cheaper, and the work moves from the model into code over time.

## Done when

- A migration and the lookup step exist. A second run on a page with an already-approved card reuses it without a task, shown in a test.
- Real variants stay apart: different `truncate` values give different signatures (`subtree-signature.ts` already does this).
- The decisions above are recorded in `spec.md` or an ADR.

## Pointers

- `trial/packages/dsl/src/subtree-signature.ts`
- `trial/packages/surface-canvas/src/ir/signature.ts` (Figma-side signatures, for the inventory)
