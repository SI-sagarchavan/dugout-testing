# 08 · The need, built by code from the IR

Status: ready-for-human (built; live baseline of 06 still to compare)
Type: task
Blocked by: 06

## What

Today the same question is answered three times by a model: data-bind writes `need` in loose words
("state (recent/upcoming)", "team crest 1 and 2"), hook-maker judges fit by reading, data-bind maps
fields again. Much of it is known in code already: frame-match's `content.ts` reads dates, times,
scores and repeats (`"21 JULY" reads as a date`, `"166/5" reads as a score`), layouts know what
repeats and how many, variants are known from the IR.

- `bind.load` returns a draft need built by code: the list (from the repeat), `count`, and each
  field with its kind (`date`, `time`, `score`, `image`, `state`, `text`, `number`), the node it
  is for and its placeholder as `example`. The model names the list and fields and adds `must`.
- hook-maker's fit check is code where it can be: each required field present and non-empty for
  every item in the run's output, of the kind its placeholder is (an image field is a URL, a score
  matches a score), via `cast_validate` with a schema built from the need. The model judges only
  meaning (is `teams[0].score` the runs?).

## To decide (triage)

- Where the need builder lives: `packages/library` (with `findSlots`), or data-bind.
- How much of the fit check hook-maker reports versus data-bind repeats.

## Done when

- The eval suite's (06) coverage and steps improve against its baseline, with no case worse.

## Pointers

- `agents/frame-match/src/content.ts`, `packages/library/src/slots.ts`, `agents/hook-maker/src/agent.ts` `Need`

## Comments

2026-11-09: first half built, in data-bind (the builder lives next to `groups()`, `draftNeed` in `agents/data-bind/src/facts.ts`, since it reads the same tree and repeats; move it to `packages/library` if a second agent needs it): `bind.load` returns `draftNeed` (for each repeated list, `count` and the first card's fields, each with the node, a `kind` of date, time, score, number, image or text, and the design's placeholder as `example`), and the instructions tell the model to copy them into `agent.hookMaker`'s need. Tests in `agents/data-bind/tests/facts.test.ts`. Not built: hook-maker's code fit check (each required field present and non-empty for every item, of the placeholder's kind, through `cast_validate` with a schema built from the need). It needs the answer to the second triage question (how much hook-maker reports versus data-bind repeats) and the live baseline of 06 to show it improves coverage and steps without making a case worse; `kindOf` and the `Need` fields are what it would build the schema from. `kind` is not yet a field of hook-maker's `Need`.

2026-11-09 (later): second half built. An adapter can `observe` a result (`packages/mcp/src/observations.ts`); the Cast adapter keeps the output of each `cast_run_hook` with the transform applied, and hook-maker's `verifyFinal` reads it (`agents/hook-maker/src/fit.ts`): every required item is in `covers` or `missing`, each `covers` path (from the root of the output) holds something for some item, and what it holds is of the item's `kind` (`Need.item[].kind`, copied from `draftNeed`). The model still judges meaning. A run resumed in another process has no observation and is not checked. The triage answer taken: hook-maker reports and refuses; data-bind does not repeat the check.
