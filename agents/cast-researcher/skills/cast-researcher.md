A Cast hook (the admin calls it a workflow) is a small graph: it takes caller inputs, calls one or more partner APIs, and a transform shapes their answer into the fields a page reads. A page fetches a published hook by its id and gets that output. You find the hook whose output has what a design shows.

## Reading hooks

- **cast.listHooks** gives each of dugout's hooks (ids that start `dugout_`, names that start `dugout: `): id, name, status and description. The hooks people made are not listed and are not yours to choose. A `published` hook serves a page. When two look alike, prefer the one whose description says what it is for.
- **cast.describeHook** gives the inputs (with their defaults), the steps, and the transform. Read the transform for the output's field names: they are what a design binds to. An input marked optional with a default needs no value.
- **cast.runHook** with `applyTransform: true` runs the hook once and shows its real output: its shape, with example values for each field. It is the only proof of what a hook gives: a field the description promises may be empty. It spends partner API quota and Cast's run budget, so run only a hook you have described and expect to fit, and only with `applyTransform: true` (without it you see the raw API answers, which are not what a page reads). Inputs are strings, as a page sends them.

## The output's shape

A hook's output can have any shape: a list, a list grouped by day or section, a list in a list, one object. There is no required envelope (an old hook may wrap its list in `data` and a page key `"1"`, which is a page number, not a field). Judge the shape by what the design does with it: if the design groups its matches by day, a hook that answers `days[].matches[]` fits, and a flat list gives the page regrouping to do. Say each field by its path from the root of the output, `[]` for each item of a list: `days[].matches[].teams[0].logo`, or `teams[0].logo` for a plain list.

## Judging a fit

Go through the need item by item: every text, picture, number, date and state the design shows. For each, find the field that gives it in the output, and check its value means the same thing (a crest is an image URL; a score is the runs, not the overs; a state that picks how an item looks is a short code like `R`, `U`, `L`).

- **covers**: `what the design shows → field`, e.g. `team short name → teams[0].short_name`, `score → teams[0].score`, `match state → state (R, U, L)`. Say too when the output's grouping is not the design's.
- **missing**: what the design shows that no field gives, or a field that is always empty in the output. Words the design writes itself ("VIEW ALL", "DAYS") are design copy, never missing data.
- **input**: what you ran it with. Pass `page_size` (or the hook's own count input) as the number of items the design shows, when the hook has one; leave the rest to their defaults.

Prefer the hook that covers the most; between two that cover the same, the one with fewer inputs to fill.

## When none fits

There may be no hooks of dugout's yet, or none about the need. Then a new one is built, and your answer says where from: call **cast.listApis**, and put in `apis` the ids of the connectors whose name, path and inputs say they give the need (a `/schedule` connector for fixtures, a `/listing` one for articles), best first. Prefer a connector a published hook already calls: its inputs are known to work. When a connector's description leaves it unclear whether it gives what the need asks for, **cast.fetchSample** calls it once and shows its real answer; like a run, it spends the run budget, so sample at most two. `hookId` is null and `input` is `{}`.
