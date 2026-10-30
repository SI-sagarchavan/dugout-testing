# 11 · Repair agent, first version

Status: needs-triage
Type: task (the goal of the tickets above)
Blocked by: 06, 09, harness 01, harness 02, harness 03, harness 04, harness 05

## What

The first version of the agent, built in two steps:

1. **One section.** A run takes one Figma section:
   - code steps compile it, collapse repeats, render and diff it;
   - if it fails the gate, one repair task patches, renders and diffs until it passes, the score stops improving, or the budget runs out;
   - the run ends in review.
2. **A whole page.** The same run on a page: one task per failing section, in parallel, then the merge, a whole-page render and diff, and one review.

It needs:

- **A spec:** the vision model, a budget, the tools from 06, an output schema of `{ dsl: artifactId, fidelity: { [section]: number } }`.
- **One repair skill (playbook) for every section type.** It covers reading a diff region, choosing the smallest patch, fixing a Repeater's template once, and staying within tokens.
- **The shared context first in the prompt:** tokens, the primitive schema, the page rules.

## Why

It's the payoff, and it proves the harness changes work together.

## Done when

- `pnpm agent figma-to-dsl --tenant <t> --export <id> [--node <id>]` runs a section through the worker and the CLI, and ends in review.
- On the corpus, it raises the pass rate above the baseline (04), with rounds, cost and time per page reported (09).
- The single-agent versus per-section comparison (09) has been run, and the design in `spec.md` updated if the numbers say so.

## Pointers

- `spec.md` in this folder; `agents/sitemap` (a compact `defineAgent` example)
