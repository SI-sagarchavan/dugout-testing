# 06 · A pipeline calls one writing child several times, in parallel

Status: done (2026-11-09): keyed children in `packages/sdk/src/subagents.ts`
Type: task
Blocked by: none

## What

Today a writing child "builds one thing per parent run": `childCaller` keeps `completed` and
`failures` by parent run id, and the child's run id is `attemptId(parentRunId, childId, attempt)`.
A second `bind` call in the same `page.build` is answered with the first call's result, and two
calls at once would share a run id.

Give a call a key: `call(child, input, { key })` in `Pipeline.run`. The key joins the identity:
`completed` and `failures` by `(parent run, key)`, run id `attemptId(parent, child, attempt, key)`,
and retries (three tries at most) counted per key. No key is today's behaviour, unchanged.

Calls with different keys may run at once (`Promise.all`); the pipeline limits how many
(`concurrency`, default 2). A child that waits for a person pauses only its own key; the parent
run resumes each answered child (check ADR 0029's one-pause rule: two children asking at once must
come out as one pause with both questions, or be serialised).

## Done when

- SDK tests: two keyed calls of a writing child give two child runs with their own ids and answers;
  one failing is retried alone; a restarted worker finds each key's tries in the store; two at once
  both complete; two that ask are answered in one pause.
- `pnpm agent runs` and `attach` show each keyed child (its key in the event's `child` tag).
- ADR 0025 extended (or a new ADR) for keyed children.

## Pointers

- `packages/sdk/src/subagents.ts`: `childCaller` (~140–260), `pipelineTool` (~398), `attemptId`
- ADR 0025 (subagents that write), 0029 (pauses), 0031 (one stream per invocation)
