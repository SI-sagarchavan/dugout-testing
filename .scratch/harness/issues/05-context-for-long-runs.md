# 05 · Context for long runs: shared part first, old rounds trimmed

Status: ready-for-agent
Type: task
Blocked by: 01

## What

Keep what's sent to the model small and cheap however long a run or task goes on:

- **Old rounds trimmed.** A tool can mark its results as replaced by its next call. Only the newest replaced result keeps its images; older ones shrink to a one-line summary, for example "round 2: padding 16 → 24, 88% → 91%". The general rule: compact older tool results and drop their images.
- **The saved transcript keeps everything,** so traces, evals and reviews can see every round. Only the request sent to the model is trimmed.
- **Shared part first.** Context that's identical across tasks and turns goes at the start of the prompt in a fixed order: instructions, skills, house facts, shared run context. Providers then serve it from their prompt cache. Cached input tokens are already recorded in usage, so the saving is visible.

## Why

Loops that check their own work pile up tool output and images. Quality drops and cost climbs. ADR 0006 lists transcript compaction as not done yet.

## Done when

- In a scripted ten-round task, round ten sends the model the same number of images as round two.
- One-line summaries of earlier rounds appear in order, and the saved transcript still has every round.
- Two tasks in one run send an identical prompt prefix, checked in a test.

## Pointers

- `packages/core/src/loop.ts` (request building), `packages/memory` (context builder)
- ADR 0006 ("not yet: compaction of long transcripts")

## Comments

- 2026-11-02: the "old rounds trimmed" part is planned in `.scratch/harness-orchestration/issues/02-context-view.md`, as a view of the transcript built by a hook. The shared-prefix part stays here.
