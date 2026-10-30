# 06 · One review per run, decisions aimed at a task

Status: needs-triage
Type: design + task
Blocked by: 04

## What

Approvals today belong to one tool call in one loop (ADR 0005). A run made of tasks needs one review at the end that covers all of them:

- The review request lists each task's result, with artifact ids for anything visual and its score.
- The reviewer can:
  - approve the whole run;
  - reject it with a reason;
  - send changes aimed at tasks ("news: tighten the header spacing").
- A change goes back to that task, inside the same run. Other tasks stay as they are. When the reworked tasks finish, the run asks for review again.
- Who decided is recorded per decision, as today.
- The CLI shows the review as text with artifact paths. A visual review belongs in the host's UI, reading the same ids.

## Why

One request is one run with one review, and reworking only what the reviewer named saves redoing the whole job.

## Done when

- The decision contract can carry changes per task. `ApprovalDecision` gains an optional target, recorded in an ADR.
- A scripted run reworks one of three tasks after a targeted change, then completes.
- The host contract in ADR 0009 is updated: how a host reads a review and sends a targeted decision.

## Pointers

- `packages/contracts/src/runtime.ts` (`ApprovalRequest`, `ApprovalDecision`), `packages/core/src/loop.ts`
- `apps/worker/src/queue.ts` (`decide`), `apps/cli/src/session.ts`
- ADR 0005, ADR 0009
