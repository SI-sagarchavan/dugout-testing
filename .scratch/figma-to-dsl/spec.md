# Figma to DSL agent

Status: planning, 2026-10-30. Nothing is built yet. This file records what has been decided and why. Work that only this agent needs is in `issues/`. General harness work it depends on is in `../harness/` (images, artifacts, runs with tasks and more), since other complex agents need it too.

## The job

A designer sends a Figma selection from the plugin: a whole page, one section, or a single button. The agent turns it into a DSL tree that the FanOS renderer draws to match the Figma screenshot. Later it also adds data bindings and logic. The result is reviewed by a person and then published.

## How a run works

```
One Figma send = one run
   1  compile                code    Figma IR → a DSL tree of primitives (@fanos/compile)
   2  find repeats           code    DSL subtree signatures → Repeater (@fanos/dsl collapseToRepeater)
   3  reuse                  code    subtrees approved before, matched by signature, used as they are
   4  render + diff          code    per section: score, plus failing regions with the node ids under them
   5  repair tasks           agent   one task per failing section, inside this run, a few at a time.
                                     Each has its own small context: patch → render → diff, until the
                                     gate passes, the score stops improving, or the budget runs out
   6  merge + page check     code    render and diff the whole selection; consistency checks
   7  binding                agent   later: which nodes take which Cast data
   8  logic                  agent   later: states, conditions, actions
   9  review                 person  one review: Figma | render | diff per section. A change can name
                                     a section and goes back to that section's task
  10  remember               code    approved subtrees saved by signature, per tenant
```

The result is one DSL version (an artifact id) plus a fidelity score per section.

## Decided

- **One Figma send is one run.** A page, a section or a button: the host (plugin, Studio, backend) sees one run id, one event stream, one review and one result. Sections are not separate runs.
- **Sections are tasks inside the run.**
  - Each task has its own transcript and save point, so contexts stay small however big the page is.
  - Tasks run at the same time, up to a limit. Events carry the section they belong to.
  - The run has one budget.
  - A worker crash or deploy resumes the run: finished tasks stay finished, and unfinished ones resume from their last save.
- **Primitives only.** UI is a tree of DSL primitives: Box, Button, Carousel, Countdown, Custom, Divider, Grid, Icon, Image, Link, Overlay, Repeater, RichText, Section, Stack, Tabs, Tag, Text. Atoms, molecules and organisms are the old admin system and play no part here.
- **Code first.** Compile, repeat detection, reuse, render, diff, the gate and the merge are code. The model only repairs what code got wrong, and the week-one baseline measures how much that is.
- **One repair agent, one repair skill, for every kind of section.** A carousel, a news grid and a newsletter need the same skill. What differs is input: the crop, the IR slice, the diff. Agents are specialised by job (repair, binding, logic), not by section type. A split by section type only happens if evals show one type failing for a reason the shared skill can't fix.
- **Repair patches, it never regenerates.** The model sends small operations on node ids, and each result is a new DSL version. `@fanos/dsl` `ops.ts` was built for exactly this.
- **Big things by reference.**
  - Screenshots, the Figma export, renders, diffs and DSL versions live in S3, keyed by content hash under the tenant's prefix.
  - Run input, transcripts and events hold only ids.
  - The harness turns an image id into bytes when it builds each model request.
  - Tools read the Figma IR in slices.
- **Tenant from the run, never from the model.** The model passes ids; tools resolve them only inside the run's tenant.
- **Shared context once, first in every prompt.** Tenant tokens, the primitive schema (token values limited to the tenant's palette), page rules decided before splitting (spacing scale, naming, which Repeater each repeat group uses) and the repair playbook. Identical prefixes are cheaper through provider prompt caching.
- **No recreation.**
  - What code can build, code builds.
  - Repeats become one Repeater, fixed once.
  - Approved subtrees are reused by signature, and real variants stay apart (`subtree-signature.ts` keeps different `truncate` values separate).
  - Unchanged nodes are not redone on a re-send.
- **Each task only writes its own subtree.** The patch tool refuses node ids outside it, so the merge can't conflict.
- **Consistency across sections** (the main multi-agent risk): shared rules decided before splitting, writes meeting in the merge step, and a whole-page check after it.
- **Zod stays** for input, tool arguments and output. `@fanos/dsl`'s validator also checks every DSL version.
- **Hosts and workers as in ADR 0009.** The run executes on the worker. The plugin, Studio or backend queues it and follows its events.
- **Temporal later.** The run maps to a workflow and tasks to child workflows. Whatever we build now keeps that shape, so moving to Temporal changes the engine and not the agent.

## Open decisions

- How dugout reaches the FanOS code: compile, dsl, renderer and diff, gate, signatures (issue 01).
- Which vision model (issue 02).
- How the binding step reaches Cast (issue 10, with harness 10). That step comes later.

## What already exists

In FanOS (the `trial` repo):

| Need                                                                           | Where                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Figma IR → DSL                                                                 | `packages/compile`                                                                                  |
| Primitives, validator, patch operations, subtree signatures, binding refs      | `packages/dsl` (`nodes/`, `validate.ts`, `ops.ts`, `subtree-signature.ts`, `binding.ts`, `cast.ts`) |
| Render to PNG in headless Chromium, pixel diff with regions mapped to node ids | `packages/renderer` (`harness.ts`, `harness/diff.ts`)                                               |
| Fidelity gate (score and thresholds)                                           | `apps/api/src/modules/fidelity/domain/gate.ts`                                                      |
| Conformance checks and gap report                                              | `packages/conform`                                                                                  |
| Figma IR signatures (strict and family)                                        | `packages/surface-canvas/src/ir/signature.ts`                                                       |
| Figma exports with screenshots stored as blobs                                 | `apps/api` (`figma_exports`, artifacts module)                                                      |

In dugout:

| Need                                                                                               | Status                                                |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Durable runs: save after every step, resume, hand-over, crash recovery                             | Exists (ADR 0006, ADR 0009)                           |
| Worker, queue, event stream, CLI host                                                              | Exists (ADR 0009)                                     |
| Typed tools with zod checks; structured output through `final`                                     | Exists                                                |
| Approvals with change requests in the same run                                                     | Exists (ADR 0005)                                     |
| Skills, memory, evals with a pass gate, tracing and cost                                           | Exist                                                 |
| Big tool outputs stored and read back by reference                                                 | Exists for text (`packages/core/src/output-store.ts`) |
| Images, artifacts, runs with tasks, model per agent, context trimming, review per run, image evals | Missing: see `../harness/spec.md`                     |

## Gaps

General harness work this agent needs, from `../harness/` (tier 1): 01 images in messages, 02 artifact store, 03 model per agent, 04 runs with tasks, 05 context for long runs, 06 review per run, 07 evals with artifacts. Later: 09 step cache, 10 MCP tools.

Work for this agent only:

| #   | Ticket                                                                             | Status          | Blocked by             |
| --- | ---------------------------------------------------------------------------------- | --------------- | ---------------------- |
| 01  | [How dugout reaches FanOS code](issues/01-reach-fanos-code.md)                     | ready-for-human |                        |
| 02  | [Choose the vision model](issues/02-choose-vision-model.md)                        | ready-for-human |                        |
| 03  | [Pick the corpus](issues/03-pick-the-corpus.md)                                    | ready-for-human |                        |
| 04  | [Baseline: compile, render, diff, no model](issues/04-baseline-without-a-model.md) | ready-for-agent | 01, 03                 |
| 05  | [Render and diff as a service](issues/05-render-service.md)                        | ready-for-human | 01                     |
| 06  | [Tools over the FanOS code](issues/06-figma-dsl-tools.md)                          | ready-for-agent | 01, 05, harness 01, 02 |
| 07  | [Reuse approved subtrees](issues/07-reuse-approved-subtrees.md)                    | needs-triage    | 01, harness 06         |
| 08  | [Skip unchanged nodes on a re-send](issues/08-skip-unchanged-nodes.md)             | ready-for-agent | harness 09             |
| 09  | [Evals that score fidelity](issues/09-fidelity-evals.md)                           | ready-for-agent | 04, harness 01, 02, 07 |
| 10  | [Cast access for the binding step](issues/10-cast-access.md)                       | ready-for-human |                        |
| 11  | [Repair agent, first version](issues/11-repair-agent-v1.md)                        | needs-triage    | 06, 09, harness 01–05  |

## Order of work

1. **Harness tier 1 first** (`../harness/spec.md`). In parallel with it, the decisions and the corpus: 01, 02, 03.
2. **The baseline with no model (04).** Its numbers show how much of each page code alone gets right, so they size the agent's job.
3. **The render service (05) and the tools (06).**
4. **Evals that score fidelity (09),** then the repair agent on one section (11), then on a whole page.
5. **Reuse (07) and skipping unchanged nodes (08)** once real runs show what repeats.
6. **Binding (10) and logic,** after repair works.

## Words used here

- **Run:** one Figma send, from queueing to the reviewed result.
- **Task:** one section's repair inside a run, with its own context.
- **Section:** a top-level part of the selection, usually a `Section` primitive.
- **Primitive:** one of the DSL node types above.
- **Subtree signature:** `@fanos/dsl`'s hash of a subtree's design, ignoring the data a CMS would swap. Same signature means the same component with different data.
- **Artifact:** an immutable file in S3, keyed by its content hash.
- **Gate:** the fidelity threshold that decides whether a section passes.
