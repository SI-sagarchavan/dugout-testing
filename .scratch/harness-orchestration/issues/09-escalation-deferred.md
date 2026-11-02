# 09 · Escalation: a stronger model when a check fails (deferred, measure first)

Status: needs-info
Type: research, then task
Blocked by: none

## What

Start a task on a cheap model, and redo it on a stronger one when a check fails (`verifyFinal`, a
measurement, the validator). It decides from a measured failure, not a guess. Spec: section H.

If evals show a gap, the smallest design is a model ladder on a program task:
`task(id, { agentId, input, models: ["haiku", "sonnet", "opus"], until })`, where attempt _n_ runs on
`models[n-1]`. `TaskRequest` already has `attempt`, and a run already takes a model override, so the
change is a `model` field on `TaskRequest`.

## First: find out whether it would pay

Run `pnpm eval sitemap` and `pnpm eval card-match` on `haiku`, `sonnet` and `opus` (`--model`), and
record pass rate and cost in the spec. Our card-match data says the model adds at most 0.28 points
in 13 of 15 runs, so there may be nothing to escalate for.

## Trigger to build

A task where a stronger model passes a check the cheaper one fails, by enough to cost less than
always using the stronger one.

## Done when

- The comparison is in the spec, with a recommendation.
- If a gap is found: tests with scripted models (attempt 1 on the cheap model, a failing check, attempt 2 on the next one, `maxAttempts` ends it as `stopped`).
