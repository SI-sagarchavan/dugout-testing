# 05 · A fallback model when the first one is unavailable

Status: ready-for-agent
Type: task
Blocked by: none

## What

`config/models.json` gets an optional `fallback`: another model's name, one level. After
`MODEL_RETRIES`, and only for a `TransientModelError`, `steps.model` tries the fallback for that turn.
The next turn tries the primary again. Loading the list refuses a fallback that:

- leaves the region (`in.*` only falls back to `in.*`);
- is itself a fallback chain.

For a switch between models, signed reasoning blocks are dropped from that request, and forced
tools follow the fallback's own entry. `step.completed` says the turn was a fallback, and pricing
uses the model that answered. Spec: section E.

A wrong answer, a refusal or a validation error never falls back.

## Pairs (decided 2026-11-02)

- `sonnet` → `sonnet-india`
- `sonnet-deep` → `sonnet-india` (a lower effort than its own, noted in the event)
- `opus` → `opus-india`
- none for `haiku`, the Nova models and `terra`: cheap or another family, and the worker already resumes a failed run later

## First: a live check

On Bedrock (si-main), while `global.anthropic.claude-sonnet-5-5` is being throttled (or with a
quota test), does `in.anthropic.claude-sonnet-5` answer? The fallback only helps if the two
profiles have separate capacity. Record the result in the ADR.

## Done when

- Tests written first:
  - a throttle after the retries answers from the fallback, and the event says so;
  - a validation error never falls back;
  - a cross-region fallback fails the load;
  - reasoning blocks are not sent to the fallback;
  - the turn is priced at the fallback's prices;
  - the next turn tries the primary again.
- ADR 0015 amended.

## Pointers

- `packages/core/src/local.ts` (`createLocalSteps`, `MODEL_RETRIES`), `model/config.ts` (loading checks), `model/bedrock.ts`
