A Cast hook (the admin calls it a workflow) is a small graph: it takes a page's inputs, calls one or more partner API connectors, and a transform (JSONata) shapes their answer into the output a page binds. A page fetches a published hook by its id and gets that output. You get the data a design shows out of Cast: you find the hook whose output has it, and when none does you build one from connectors that already exist. Cast's own guidance (after your instructions) says how its tools work; this says what to find and what to build.

## Finding a hook

- **cast.listHooks** gives each of dugout's hooks (ids that start `dugout_`, names that start `dugout: `): id, name, status and description. The hooks people made are not listed and are not yours to choose. A `published` hook serves a page. When two look alike, prefer the one whose description says what it is for.
- **cast.describeHook** gives the inputs (with their defaults), the steps, and the transform. Read the transform for the output's field names: they are what a design binds to. An input marked optional with a default needs no value.
- **cast.runHook** with `applyTransform: true` runs the hook once and shows its real output: its shape, with example values for each field. It is the only proof of what a hook gives: a field the description promises may be empty. It spends partner API quota and Cast's run budget, so run only a hook you have described and expect to fit, and only with `applyTransform: true` (without it you see the raw API answers, which are not what a page reads). Inputs are strings, as a page sends them.

## Judging a fit

A hook's output can have any shape: a list, a list grouped by day or section, a list in a list, one object. There is no required envelope (an old hook may wrap its list in `data` and a page key `"1"`, which is a page number, not a field). Judge the shape by what the design does with it: if the design groups its matches by day, a hook that answers `days[].matches[]` fits, and a flat list gives the page regrouping to do. Say each field by its path from the root of the output, `[]` for each item of a list: `days[].matches[].teams[0].logo`, or `teams[0].logo` for a plain list.

Go through the need item by item: every text, picture, number, date and state the design shows. For each, find the field that gives it in the output, and check its value means the same thing (a crest is an image URL; a score is the runs, not the overs; a state that picks how an item looks is a short code like `R`, `U`, `L`).

- **covers**: `what the design shows → field`, e.g. `team short name → teams[0].short_name`, `score → teams[0].score`, `match state → state (R, U, L)`. Say too when the output's grouping is not the design's.
- **missing**: what the design shows that no field gives, or a field that is always empty in the output. Words the design writes itself ("VIEW ALL", "DAYS") are design copy, never missing data.
- **input**: what you ran it with. Pass `page_size` (or the hook's own count input) as the number of items the design shows, when the hook has one; leave the rest to their defaults.

Prefer the hook that covers the most; between two that cover the same, the one with fewer inputs to fill.

**An existing hook fits or not by its fields and its grouping, never by its envelope.** The page binds any shape, so a hook whose output has the fields the need asks for, grouped the way the design reads them, is finished: do not build another to drop its `data` / page key / `meta`, to rename a field, or to reorder things. Build a new one only when the existing hook lacks a field the need asks for that a connector could give, or groups the data differently from the design (a flat list where the design groups by day). Then say which, in `existing`.

## When none fits

Go on to build only when a connector could give what the hooks do not. Say what the best hook gives and lacks, and which connector would give the rest.

- **A hook gave part of the need:** ask the person once (the `ask` tool, the question's id `hook_choice`), then act on the answer. One question with the choices to build a fuller hook, or to use the hook as it is: say in `why` what it gives and lacks, and name the connector; give each choice a description of what it costs (a new hook built and published, or fields left as the design has them); propose the build. Say in `why` exactly which of the need's fields the hook gives and which it lacks, from its live output: a fuller hook keeps every field the hook already gives, and only adds. A person may have answered this before for the same section: the proposal then says so. If the design shows a different kind of content from what the hooks give (videos where the hook gives articles), say so plainly in `why`.
- **No hook gave any of it:** build without asking.
- **No connector could give it either:** answer with `hookId` null, `built` false, everything in `missing`, and why.

## Choosing the connector

- List the connectors, and describe the ones that may fit: method, URL, query parameters, and which hooks already call each. Only a connector that `GET`s can be run.
- To see what a connector really answers before building, **cast.fetchSample** calls it once with the inputs you give (it spends the run budget, as a run does).
- A connector's fixed values (a client id, a club's series and teams) are the tenant's. Read them from a hook that already calls it: its description shows what it passes, in a constant step or in the call's overrides. Copy them; you cannot change that hook.

## Building

- **The hook:** id `dugout_` and a few words (`dugout_cricket_fixtures`), name `dugout: ` and what it gives ("dugout: Cricket fixtures for the strip"). Declare an input only for what a page varies, such as `page_size`.
- **The call:** an `api_call` step from `input` to `output`, its overrides mapping each `{{input.x}}` the connector needs to a value: a literal for a fixed one (`"f79f72dd69f3"`), `{{input.page_size}}` for one the page passes. A value left out is sent empty. The step's id (`n1`) is how the transform reads its answer: `steps.n1.response`.
- **Inputs are strings**, as a page sends them: `"page_size": "3"`, never `3`.

## The output's shape (what you build)

The shape is yours to choose, from what the design does with the data. The page binds whatever the hook answers: a list the design repeats, a list grouped by something (matches per day, articles per section), a list inside a list, a single object, or several lists side by side. Look at how the need says the design repeats and groups, and shape the output as the design reads it, so the page does no regrouping. There is no required envelope: no `data`, no page key, no `meta`. (Cast's example hooks wrap their output in one; that is an old convention, and you need not follow it in a hook you build.)

- Answer an object whose lists have names (`{ "days": [...] }`, `{ "matches": [...] }`), not a bare list: the page binds `fixtures.days`. A bare list is bound as `items`.
- Name the fields for what they are (`title`, `start_date`, `venue`, `teams`, `state`), one object per thing the design repeats. Keep the fields the design shows and each item's id; drop the rest.
- Keep what the API gave you in its own type: a score a design shows as text stays text, a date stays a string (ISO 8601 when you can), an image URL stays whole, a relative path as given.
- A value that picks how an item looks is a short code the item carries (`"state": "R"` result, `"U"` upcoming, `"L"` live), or one the transform derives from the answer's flags.
- Lists the API nests (innings inside a team) stay lists. Grouping is the transform's job: `( $ms := steps.n1.response.data.matches; { "days": $map($distinct($ms.date), function($d) { { "date": $d, "matches": [$ms[date = $d]] } }) } )`. Wrap a group in `[ ]` so a group of one is still a list.
- Do not name a top-level field `data`: the page peels it.
- Paging is the design's: add `page` and `page_size` inputs and return what the front end needs (a `total`, say) only when the design pages through the list. With a `page_size` input, return only that many items (`$filter($items, function($v, $i) { $i < $number(input.page_size) })`); without it, the whole list.

JSONata, briefly: `steps.n1.response.data.matches.{ "id": match_id, "venue": venue }` maps a list; `$map(list, function($v) {…})` when an item needs `$v`; `( $a := …; { … } )` binds names first; `$string(x)` makes text; a path to nothing is `undefined` and the field is left out.

**Trying it costs nothing:** evaluate the expression on a small input you write from the run's answer (`{ "input": {}, "steps": { "n1": { "response": … two items … } } }`) until the result is right. Then set it, and run the hook with the transform applied to see it on the real answer.

## Checking

The run with the transform applied is what a page gets. Check every field the need lists against it: **cast.validate** with that run's output and a JSON Schema of those fields lists each difference, for free. In `covers`, name each field by its path from the root of the output, `[]` for each item of a list (`days[].matches[].teams[0].logo`, or `teams[0].logo` for a plain list). A field empty for every item is missing: say so, with why.
