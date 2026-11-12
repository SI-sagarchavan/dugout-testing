A Cast hook (the admin calls it a workflow) is a small graph: it takes a page's inputs, calls one or more partner API connectors, and a transform (JSONata) shapes their answer into the output a page binds. A page fetches a published hook by its id and gets that output. You get the data a design shows out of Cast: you find the hook whose output has it, and when none does you build one from connectors that already exist. Cast's own guidance (after your instructions) says how its tools work; this says what to find and what to build.

## Earlier builds

When frame.load (bind.load, built.load) returns `built`, it lists how this section was built before: `same` (the latest good records of this very section), `like` and `failed` (what did not work, or a person changed afterwards). It is an index; read a record in full with `memory.read({ id })` only when its line looks worth it.

- Start from the latest good record of the same section: take its approach, and check each part with your own tools. A record is not evidence: call built.load first. A hook a record names is run live (step 1) before you answer with it: it may be gone or changed, and a record that names the wrong hook costs one failed run, not a wrong answer.
- `like` lists records of sections like this one (`why` says how): take the approach, never the ids, hook names or values; check everything against this frame. Memory can be wrong for a section that only looks alike.
- Read `failed` as what not to repeat. A record with `corrected` says what a person changed after it; do not make that mistake again.
- `patterns` are facts a person approved from what was built on several sections (the hook that feeds a list, the form a date is written in, a kind of section's layout): they outrank a record, and your tools still check them.
- A decision a person made (`before`) outranks a record.
- When a record was wrong for this frame, say so in `remaining`.

## Finding a hook

- **A hook this section already has comes first.** `built.load`'s `hooks` lists the hooks earlier runs on this section answered with, newest first. Run the newest with the input it ran with and read it with `hook.evidence`: when it gives what the need asks for, answer with it (`built` false). A section that already shows data keeps showing the same data, and nothing is built twice. Build or change one only for something it lacks that a connector could give, and say in `existing` what it lacks. The same holds when a person gave feeds: a hook of the section that already calls those feeds is reused, not built again.

- **cast.listHooks** gives each of dugout's hooks (ids that start `dugout_`, names that start `dugout: `): id, name, status and description. The hooks people made are not listed and are not yours to choose. A `published` hook serves a page. When two look alike, prefer the one whose description says what it is for.
- **cast.describeHook** gives the inputs (with their defaults), the steps, and the transform. Read the transform for the output's field names: they are what a design binds to. An input marked optional with a default needs no value.
- **cast.runHook** with `applyTransform: true` runs the hook once and shows its real output: its shape, with example values for each field. It is the only proof of what a hook gives: a field the description promises may be empty. It spends partner API quota and Cast's run budget, so run only a hook you have described and expect to fit, and only with `applyTransform: true` (without it you see the raw API answers, which are not what a page reads). Inputs are strings, as a page sends them.

## Judging a fit

A hook's output can have any shape: a list, a list grouped by day or section, a list in a list, one object. There is no required envelope (an old hook may wrap its list in `data` and a page key `"1"`, which is a page number, not a field). Judge the shape by what the design does with it: if the design groups its matches by day, a hook that answers `days[].matches[]` fits, and a flat list gives the page regrouping to do. Say each field by its path from the root of the output, `[]` for each item of a list: `days[].matches[].teams[0].logo`, or `teams[0].logo` for a plain list.

Go through the need item by item: every text, picture, number, date and state the design shows. For each, find the field that gives it in the output, and check its value means the same thing (e.g. a crest is an image URL; a score is the score, not another figure printed beside it; a state that picks how an item looks is a short code such as `R`, `U`, `L`).

- **covers**: `<the need's field, as the need writes it> → <path>`, e.g. `team short name → teams[0].short_name`, `score → teams[0].score`, `match state → state (R, U, L)`. Say too when the output's grouping is not the design's.
- **missing**: for people, what the design shows that no field gives, or a field that is always empty in the output, each line starting with the need's field (`tickets link: no connector has it`). Words the design writes itself ("VIEW ALL", "DAYS") are design copy, never missing data.
- **about** (when the need has a `must`): whether the data is about it (`design`), about another team or competition (`other`), or does not say (`unknown`), with why: what the data names, from `hook.evidence`. A feed may never name its own team (a squad's players), and may name it by a short name or initials: read the names, then decide.
- **input**: what you ran it with. Pass `page_size` (or the hook's own count input) as the number of items the design shows, when the hook has one; leave the rest to their defaults.

Prefer the hook that covers the most; between two that cover the same, the one with fewer inputs to fill.

A hook that gives what the need asks (its fields, grouped as the design reads them, in its order, enough of them, about its `must`) is finished, whatever its envelope. Build another only when it does not and a connector could; then say in `existing` why it would not do.

## When a person gave the feed

`need.sources` lists feeds a person gave for this data, each with a `label` (the part of the design it is for: `women`, `men`) and a `url`. They are the source: build on them, and look for a hook that already calls them only to avoid building a second copy. Dugout's connectors and providers are named `dugout: …`; you create them, you never change one (a connector is shared by every hook that calls it, so a call that names an `id` is refused).

1. **Plan.** Call `feeds.plan` with `need.sources`. It works out, by code and the same way every time, the providers and connectors: one provider for each origin (scheme and host), its `baseUrl` the origin and no path, so every feed of that host, whatever its path or version, is under the one provider; one connector for each path, the whole path in its `url` (`{{env.base_url}}/<the path>`); and the query parameters in the feeds' order, still encoded: a literal when every feed of the connector has the same value, `{{input.<name>}}` when they differ or only some feeds have it (each call's `input` sets only what its feed has), and `{{cred.<name>}}` for a parameter that holds a secret. Which parameters hold one is yours to decide: `looksSecret` lists those that look like one and why (a name such as `key` or `token`, a long random value); left to it, the plan proposes them (`secretsBy: "proposal"`). Read the feeds' parameters, and call it again with `secrets` (the parameter names; `[]` for none) when the proposal is wrong: an id or a page number is no secret, a password under another name is. A feed it refuses (not a URL, not http, a user name or password in the URL) goes in `missing`.
2. **Create.** `cast.listProviders` and `cast.listApis` first: reuse a provider of yours whose `baseUrl` is the plan's origin exactly (one under a path of the same host is not it), and a connector of yours with the same `url` and parameters. Otherwise create what the plan says, nothing else: `cast.upsertProvider` (`name` and `baseUrl` from the plan, `authMode` `none`), then `cast.upsertApi` for each connector (`name` `dugout: <what it gives>`, `method` `GET`, `url` and `queryParams` from the plan, `providerId`). Each feed's own call then passes the plan's `input` for it, as the step's overrides.
   - **A secret** (`secrets` in the plan): its value is never written anywhere, not in a connector, a provider, a hook or your answer. The connector reads it as the credential the plan names (`{{cred.<name>}}`); ask the person once (the `ask` tool) to add that credential's value in Cast, in your own words: which feeds need it and why it is a secret. Until they say it is there, the feed's data goes in `missing`.
3. **See it.** `cast.fetchSample` with each source's own values (at most two samples). A source that does not answer 200 with JSON is reported in `missing` with its status, and its connector is not kept in the hook.
4. **Build** as the other sections say: a hook with the inputs a page varies, one `api_call` step for each source (the same connector, other values), a transform, a run with it, and publish. Where a page choice filters the list (the sources split by WOMEN and MEN tabs), follow "When a page choice filters the list": one list, each item tagged with its option. Say what you did in `why`.
5. **final:** `built` true, `covers` and, with a `must`, `about`. What you created (providers, connectors, the hook) is listed by code from your own calls: leave `created` out.

## When none fits

Go on to build only when a connector could give what the hooks do not. Say what the best hook gives and lacks, and which connector would give the rest.

- **A hook gave part of the need:** settle it from memory, or from the evidence when it settles it (say why), or ask the person once (the `ask` tool, id `hook_choice`, `remember: section`), then act on the answer. When you ask, write the question yourself: offer a fuller hook and using the hook as it is, and anything else that would serve (a hook a person names, a feed they give): say in `why` what it gives and lacks, and name the connector; give each choice a description of what it costs (a new hook built and published, or fields left as the design has them); propose the build. Say in `why` exactly which of the need's fields the hook gives and which it lacks, from its live output: a fuller hook keeps every field the hook already gives, and only adds. A person may have answered this before for the same section: the proposal then says so. If the design shows a different kind of content from what the hooks give (videos where the hook gives articles), say so plainly in `why`.
- **No hook gave any of it:** build without asking.
- **No connector could give it either:** answer with `hookId` null, `built` false, everything in `missing`, and why.

## Choosing the connector

- List the connectors, and describe the ones that may fit: method, URL, query parameters, and which hooks already call each. Only a connector that `GET`s can be run.
- To see what a connector really answers before building, **cast.fetchSample** calls it once with the inputs you give (it spends the run budget, as a run does).
- A connector's fixed values (a client id, a club's series and teams) are the tenant's. Read them from a hook that already calls it: its description shows what it passes, in a constant step or in the call's overrides. Copy them; you cannot change that hook.

## Building

- **The hook:** id `dugout_` and a few words (`dugout_club_fixtures`), name `dugout: ` and what it gives ("dugout: Club fixtures for the strip"). Declare an input only for what a page varies, such as `page_size`.
- **The call:** an `api_call` step from `input` to `output`, its overrides mapping each `{{input.x}}` the connector needs to a value: a literal for a fixed one (`"f79f72dd69f3"`), `{{input.page_size}}` for one the page passes. A value left out is sent empty. The step's id (`n1`) is how the transform reads its answer: `steps.n1.response`.
- **Inputs are strings**, as a page sends them: `"page_size": "3"`, never `3`.

## A picture the feed does not give

When a need's field is a picture (a player's photo, a crest, a thumbnail, a poster) and the output has no URL for it: look first. Check the feed for any field that looks like a picture URL (a path or URL ending in an image extension, whatever it is called), and a sibling connector that has one (a players or teams feed; `cast.listApis` names them). Use it when it joins on the item's id. When nothing gives it, leave the picture out and say in `missing` what you found: the item's id field with a real value, any URL-shaped fields, and the connectors you looked at. data-bind asks for a URL pattern (or uses a `media.*` house fact) with that evidence; never invent a URL.

A need's field of kind `link` is the item's own page, which a press on the card opens: a URL or path the feed gives (`detail_url`, `url`, `permalink`), else the slug or id a page's address is made from (data-bind builds the URL with a `route.*` house fact). Give it under the field's name; never invent a URL.

## The design's form

The feed often has the value the design shows in another form. The page shows what the hook gives, so the hook gives the design's form: compare each field's values with its `example` in the need (`hook.evidence` shows them side by side) and judge whether they are the same kind of thing written the same way. A value that fills part of the example (the number the design writes words around, the runs of a score) is the design's form: the page writes the rest.

- **A unit converted:** the design counts in one unit and the feed in another (minutes where it gives seconds, km where it gives m, a percentage where it gives a ratio, a count where it gives a measure written another way). Derive the design's unit in the transform with the size of one unit in the other, from the data itself (a field that gives it, or two fields that give both) or from a house fact, never from what such data usually holds. When neither says the size, leave the field as the feed gives it and say in `missing` which size is not known. Give the number, not the unit's words: the page writes the words around it.
- **One field split, or several joined:** the design draws a name on two lines and the feed has one `name`: give `first` and `last` (`$split`); the reverse, join them.
- **A code made a word:** `R`/`U`/`L` become "Completed", "Upcoming", "Live" in a field of its own, keeping the code too when the page chooses a card by it.
- **What a card shows depends on the item:** when the need's field has `alternatives` (a bowler's card says Wickets where a batter's says Runs), give each item the fields its kind has, as a list of `{ label, value }` the page repeats, or every field the alternatives name with the empty ones left out.
- Dates and times stay instants (an ISO string): the page formats them with the club's zone.

Say in `covers` what you derived and from what: `<the need's field> → <path> (derived from <field>, <how>)`.

## When a page choice filters the list (`need.filterBy`)

Tabs, a toggle or a filter above a list (e.g. WOMEN | MEN, RESULTS | UPCOMING, ALL | NEWS | VIDEOS, a season) decide which items show. Give the page **one list** and a field on each item that holds the option the item belongs to, written exactly as `need.filterBy.options` writes it: the options are given as the page writes and compares them, so copy them, never respell them. The page shows the items whose field is the chosen option. Say the field in `covers`: `filterBy → items[].<field>`.

- The feed already has the field (whatever it calls it): keep it, and map its values to the options in the transform when they are written differently from `need.filterBy.options`.
- The data comes one feed for each option: the transform tags each feed's items with its option and joins them into one list (`$append($map(steps.n1.response.<list>, function($p) { $merge([$p, { "<field>": "<option>" }]) }), …)`). Each option's items keep the need's order on their own.
- Every option must have items in the output, or choosing it draws nothing: the check reads the field's values.
- Side-by-side lists (`{ "women": […], "men": […] }`) only when no choice filters the list.

## The output's shape (what you build)

The shape is yours to choose, from what the design does with the data. The page binds whatever the hook answers: a list the design repeats, a list grouped by something (matches per day, articles per section), a list inside a list, a single object, or several lists side by side. Look at how the need says the design repeats and groups, and shape the output as the design reads it, so the page does no regrouping. There is no required envelope: no `data`, no page key, no `meta`. (Cast's example hooks wrap their output in one; that is an old convention, and you need not follow it in a hook you build.)

- Answer an object whose lists have names (`{ "days": [...] }`, `{ "matches": [...] }`), not a bare list: the page binds `fixtures.days`. A bare list is bound as `items`.
- Name the fields for what they are (`title`, `start_date`, `venue`, `teams`, `state`), one object per thing the design repeats. Keep the fields the design shows and each item's id; drop the rest.
- Keep what the API gave you in its own type: a score a design shows as text stays text, a date stays a string (ISO 8601 when you can), an image URL stays whole, a relative path as given.
- A value that picks how an item looks is a short code the item carries (`"state": "R"` result, `"U"` upcoming, `"L"` live), or one the transform derives from the answer's flags.
- Lists the API nests (innings inside a team) stay lists. Grouping is the transform's job: `( $ms := steps.n1.response.data.matches; { "days": $map($distinct($ms.date), function($d) { { "date": $d, "matches": [$ms[date = $d]] } }) } )`. Wrap a group in `[ ]` so a group of one is still a list.
- Do not name a top-level field `data`: the page peels it.
- **Enough items.** A feed may answer one page per call: its inputs may set a page size or a limit, and its answer may say how many items or pages there are in all, or link to the next. Ask it for as many items as the design draws (every item, for count `data`); when it cannot give them in one call, call it once for each page you need (one `api_call` step per page, the same connector with another page) and join the pages in the transform (`$append`). `hook.evidence` shows how many items each list holds beside the count: an output shorter than the count while the feed holds more is not finished; `missing` says only what the feed does not hold in all.
- Paging is the design's (`need.paged`: a LOAD MORE, a pager, more on scroll). The page asks for the next page by running the hook again with another `page`, so the page number is an **input** (`page`, passed to the feed's own page parameter: `{{input.page}}`, default 1), never a literal; give a `page_size` input too, defaulting to as many items as the design draws on its first page, when the feed takes one. The answer says where the list stands in one field, `next`: the next page's number, or `null` on the last page (from the feed's own paging: `current_page < total_pages`, a next link, or a full page). The page appends each next page's items to the list and reads `next` to hide its LOAD MORE, so a page's answer has the same shape as the first's. Check it with a run at `page` 2 (`hook.evidence` after it): its items are the ones after page 1's, and `next` moves on. Without `need.paged`, no paging: the whole list, as many as the design draws.

JSONata, briefly: `steps.n1.response.data.matches.{ "id": match_id, "venue": venue }` maps a list; `$map(list, function($v) {…})` when an item needs `$v`; `( $a := …; { … } )` binds names first; `$string(x)` makes text; a path to nothing is `undefined` and the field is left out.

**Trying it costs nothing:** evaluate the expression on a small input you write from the run's answer (`{ "input": {}, "steps": { "n1": { "response": … two items … } } }`) until the result is right. Then set it, and run the hook with the transform applied to see it on the real answer.

## Checking

The run with the transform applied is what a page gets. Check every field the need lists against it: **cast.validate** with that run's output and a JSON Schema of those fields lists each difference, for free. In `covers`, name each field by its path from the root of the output, `[]` for each item of a list (`days[].matches[].teams[0].logo`, or `teams[0].logo` for a plain list). A field empty for every item is missing: say so, with why.

**hook.evidence** (after the hook's last run, with the covers you mean to answer) reports what that run's output holds against the need, and judges nothing: the values at each path beside the field's example and kind, the lists and how many items each holds beside the count, the dates in output order beside the need's order and the time now, how many items hold each option of a page choice, and what the data names beside the `must`. Read it and decide: is each value in the design's form, are the items in the need's order and enough of them, is the data about the `must`? Fix the hook when it is not and the feed allows; otherwise say what is off in `missing`, and what the data is about in `about`. `final` refuses only what the output contradicts: a path that holds nothing, a path that holds no value of the field's kind, an option no item holds, a required field you did not name.
