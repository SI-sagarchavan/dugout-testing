# 09 · `bind.try` checks the right team, the design's format, every variant

Status: resolved (2026-11-10, after review)
Type: task
Blocked by: 06

## What

Three things a person sees on the page that `bind.try` lets through today (run `3acd204c`):

1. **Wrong entity.** Fixtures and squad bound to another team, no problem listed. Check: when the
   need has `must.team` (or competition), some bound text of each item, or the source's fields,
   holds it (Southern Brave, "Brave"); else a problem "the data is about <what it holds>, the
   design is about <must>". A known team list (a house fact) may help; code first.
2. **Format.** Bound "5/26/2026" where the design writes "21 JULY"; "Overs" where it writes
   "(100 Balls)". Check each bound text's `shows` against its placeholder's form (date pattern,
   letter case, brackets and words around the value) and name the pipe that would fix it
   (`date:"DD MMMM"`, `template`). The `date` pipe exists (`packages/dsl/src/binding.ts:140`).
3. **Variants nobody draws.** Every sample item was a result, so the upcoming card was never drawn
   or checked. When a variant's `when` matches no item, report it and draw it once on an item made
   from the sample's shape with the variant's state, so its refs are checked too.

Each problem is fixed in the plan or `keep`-ed with why, as today.

## Done when

- `packages/dsl` / data-bind tests for each check.
- The eval suite's (06) format and variant graders pass on `fixtures-strip` and `team-fixtures`.

## Pointers

- `agents/data-bind/src/tools.ts` (`bind.try`, `problems`, `shows`), `packages/dsl/src/binding.ts`

## Comments

2026-11-09: done in `agents/data-bind/src/facts.ts` (`dryRun`: `formats`, `unseen`; `wrongEntity`) and `tools.ts` (`bind.source` takes `about`, from the need's `must`; `bind.try` lists the three problems). Tests in `agents/data-bind/tests/facts.test.ts`. The entity check needs `about` on `bind.source`, which the model passes from the need's `must`; a run that leaves it out is not checked. A variant whose `when` reads a clock or a page choice (the reference plan's `countdown.past`) cannot have an item made for it from the sample's shape: it is reported, with that said. Not yet run: the eval suite's (06) format and variant graders on `fixtures-strip` and `team-fixtures` (those cases need a published preview, and `--live`).

2026-11-09 review, reopened:
- **Wrong-team check flags correct data.** `wrongEntity` (`agents/data-bind/src/tools.ts:1393, 1551`) falls back to the `club.team` fact or the model's `about`; unless the model copies `basis`, the source is untrusted. Confirmed: news titles ("New kit revealed") are "about something else"; "Brave" does not match "Southern Brave". Matching is by substring (`agents/hook-maker/src/entity.ts:22-30`): must `KKR` fails on "Kolkata Knight Riders", `RR` passes on "Current error", `Brave` on "Braves". Fix: run the check only on lists whose items name teams or clubs (a field that names one); match whole words, short names and initials of the must; `basis` is passed by code from hook-maker's answer, never by the model; and the problem can be kept with why (it is advice, not a gate), so a correct binding never ends as a stand-in.
- **`standInIn` misreports** (`ending.ts:103-115`): ignores order (a `stand_in` answer, then the right hook, is still a stand-in); any `missing` line naming the team ("Southern Brave crest URL") makes a stand-in. Use the latest source and whether its data is about the must, not words in `missing`.
- **A stand-in chosen from memory (`before`) is reported bound**: `dataSourceAnswer` reads only this run's `ask`. Read the settled value, whoever settled it.
- **A variant drawn on a made-up item** copies a result item, so fields only the variant has come back as fix-only missing fields: a made item's missing fields are reported as unseen, not as problems.
- `UNBOUND = "unbound"` (`ending.ts:11`) is never used; the candidate is `"none"`.

2026-11-10, review fixed: `entityReading` (`agents/data-bind/src/facts.ts`) judges only lists whose items name a team or competition in a field (a table passes when a row is the design's team; news and players are not judged); the problem is on the list's template and can be kept with why. `holdsWords` (hook-maker `entity.ts`) matches whole words, short names and initials. `standInIn` decides from the latest source per name and its reading, and whether the plan kept the problem; never from words in `missing`; order of answers respected. `bind.load` returns `settled.data_source` from memory and the ending honours it. A made-up variant item's empty refs are unseen, not holes. `UNBOUND` removed.

`basis` differs from the ticket: a tool cannot see a child run's answer, so it is not passed to `bind.source` by code; it is removed from `bind.source`'s input (the model no longer gives it), and the ending reads hook-maker's `basis` from the transcript.
