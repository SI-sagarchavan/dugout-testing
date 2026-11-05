A Cast hook takes a page's inputs, calls API connectors, and a transform (JSONata) shapes their answers into the output a page binds. You build one, end to end, from connectors that already exist. Cast's own guidance (after your instructions) says how its tools work; this says what to build.

## Choosing the connector

- List the connectors, and describe the ones that may fit: method, URL, query parameters, and which hooks already call each. Only a connector that `GET`s can be run.
- To see what a connector really answers before building, **cast.fetchSample** calls it once with the inputs you give (it spends the run budget, as a run does).
- A connector's fixed values (a client id, a club's series and teams) are the tenant's. Read them from a hook that already calls it: its description shows what it passes, in a constant step or in the call's overrides. Copy them; you cannot change that hook.

## Building

- **The hook:** id `dugout_` and a few words (`dugout_cricket_fixtures`), name `dugout: ` and what it gives ("dugout: Cricket fixtures for the strip"). Declare an input only for what a page varies, such as `page_size`.
- **The call:** an `api_call` step from `input` to `output`, its overrides mapping each `{{input.x}}` the connector needs to a value: a literal for a fixed one (`"f79f72dd69f3"`), `{{input.page_size}}` for one the page passes. A value left out is sent empty. The step's id (`n1`) is how the transform reads its answer: `steps.n1.response`.
- **Inputs are strings**, as a page sends them: `"page_size": "3"`, never `3`.

## The output's shape

The shape is yours to choose, from what the design does with the data. The page binds whatever the hook answers: a list the design repeats, a list grouped by something (matches per day, articles per section), a list inside a list, a single object, or several lists side by side. Look at how the need says the design repeats and groups, and shape the output as the design reads it, so the page does no regrouping. There is no required envelope: no `data`, no page key, no `meta`. (Cast's example hooks wrap their output in one; that is an old convention, and you need not follow it in a hook you build.)

**An existing hook fits or not by its fields and its grouping, never by its envelope.** The page binds any shape, so a hook whose output has the fields the need asks for, grouped the way the design reads them, is finished: do not build another to drop its `data` / page key / `meta`, to rename a field, or to reorder things. Build a new one only when the existing hook lacks a field the need asks for, or groups the data differently from the design (a flat list where the design groups by day). Then say which, in `existing`.

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
