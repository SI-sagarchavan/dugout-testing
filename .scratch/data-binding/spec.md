# Data and logic binding: any API, no business logic in our code

Status: proposal, 2026-11-04 (rev 2). Follows layout detection (ADR 0024). Before the Cast MCP layer.

## Done (2026-11-04): the strip bound to a static Cast response

- `apps/api/data/fixtures-strip.json`: a dummy Cast flow response in the shape the UI wants
  (`{ fixtures: { castFlow: { data: { "1": [days] } } } }`): days → matches → teams, one
  `state` per match. IPL playoff results and scores from flow `1cff832f` and its polling API, plus
  made-up Southern Brave days for live, upcoming, abandoned and a mixed day.
- `apps/api/data/fixtures-strip-plan.json`: the hand-written binding plan, the bind agent's
  reference answer.
- Binding plans gained (generic, `@fanos/dsl` `bind.ts`): `variants` (another instance's block,
  drawn behind a `when`), `shape: "varies"` (fold members no exact signature groups), `template`
  fields (words around the data), and a glyph bound to a picture becomes an Image.
- The preview unwraps a `castFlow` dataset with `fromCastFlow`, and `?plan=` takes a file name.

Preview: `/preview/default/<run tree>?…&data=fixtures-strip&plan=fixtures-strip-plan`.

Still open from this step: a score's colour is by position, not by `is_winner` (no look chosen by data yet); the
carousel opens on slide 1, not on the live day (`initialSlide` cannot be bound).

## Done (2026-11-04): the bind agent

`agents/data-bind` (`pnpm agent data-bind --tenant <t> --preview <preview link> --data <dataset>`): reads a
published frame and a sample, writes a binding plan, publishes it and returns the bound preview.
Tools: `bind.load` (outline, what repeats, the data's paths), `bind.node`, `bind.try` (applies and
draws the plan against every item, lists problems), `bind.publish` (write, behind approval).

`bind.try`'s checks are code and know no API: refs that read nothing (absent, null or empty) for
some items, items that draw no variant or two, data in lower case where the design writes capitals,
and members a collapse would draw in the first one's look (same skeleton, different tone, style or
surface).

On the strip (run `024a5206`, 7 steps, $0.08) its plan matches the reference: days over
`fixtures.items`, matches over `fixture.matches` with the upcoming card as a variant, teams bound
by position. Left: it wrote progress as `100 Balls` where the design writes `(100 Balls)`, and bound
no `alt` on the crests.

## Done (2026-11-04): clocks

Any node may carry `clock: { to, as, units }` (`@fanos/dsl` `clock.ts`, a universal prop). Its
subtree reads `{as.d}` `{as.h}` `{as.m}` `{as.s}` (the units listed; the largest carries the rest),
`{as.past}` and `{as.total}` (seconds). The designed digits are ordinary Texts bound to them, with
the new `pad` pipe (`{countdown.d | pad:2}`), so they keep their look; what shows either side of the
instant is ordinary `when` (`countdown.past`, `countdown.d gt 0`). Nothing in code knows what is
counted: a kick-off, a sale, a deadline or a match clock counting up are an instant from the data
plus units, and the binding (the agent) chooses which.

- Renderer: the server draws every clock at render time (no JavaScript, a screenshot: real
  digits). Only a Text that reads a clock (`ClockText`) and a node whose `when` reads one
  (`ClockGate`) are client parts, sharing one timer that ticks once per the smallest unit.
  The client reads data through `@fanos/dsl/runtime`, the browser-safe entry (the main entry
  brings the theme loader's file reads).
- Validator: a clock's name is in scope like a Repeater's alias; a unit not listed is B1; `to`
  whose sample is not an instant is B4.
- Bind agent: the dry run reads clocks; the data facts mark `(instant)` fields; `bind.try` reports
  a clock with no instant, and figures the design wrote that every item of a list would show (the
  check that got the agent to bind the countdown instead of listing it as remaining). Run
  `3ddc13b8`: clock on the countdown block, four digits bound, 7 steps, $0.08.
- Sample: the upcoming day moved to 2026-11-17 so it counts down.

Not yet: an instant reached does not refetch the data (that is polling, phase 5); a look chosen by
the clock (red under an hour) needs data-driven looks.

## Done (2026-11-04): the data from Cast, found by a subagent

`bind` with no `--data` finds the data itself. It calls `agent.hookFinder` (ADR 0025), a child
run with its own context. The researcher lists the tenant's published hooks, describes the likely
ones, runs the best once against its live APIs (`cast.sampleHook`) and answers with the hook, the
input it ran with, what it covers (field by field) and what is missing. `bind.source` then makes
that hook's output the run's data, under a name the plan reads it by (`fixtures`), from the same
live call. `bind.publish` records the source (`{ kind: "cast-hook", hookId, input, as }`) on the
stored sample.

Run `f52efa40` (dev Cast, tenant demo-cricket, the strip from run `3ddc13b8`): the researcher (run
`fcbd38c3`, 4 steps, $0.036) chose `fanxp-seed-hook-cricket-schedule`, which now carries scores
(`participants[].innings[].score`); bind bound 16 props in 9 steps, $0.136 in all. Left, and said
so in remaining:

- **Grouping.** The design puts two matches under one date; the hook answers one match per item.
  The plan draws one match per card. Needs `groupBy` on `Repeater` (DSL change 3 below).
- **States the sample does not show.** The first 6 items are all results, so the upcoming card was
  bound but never drawn. Sampling again with `is_recent=false` would show it.
- **Crests.** The hook gives logos as paths on the tenant's site (`/static-assets/images/teams/…`),
  which do not load on the preview's host. The renderer needs the tenant's asset host.
- **The public flow id.** The MCP gives no `hook_uuid`, which `/cast/api/flow/<id>` takes, so the
  preview draws the stored sample, not a live fetch. Asked of Cast.

## Done (2026-11-04): a hook built when none fits

The researcher now chooses only among dugout's hooks (ids `dugout_…`, names `dugout: …`); the
hooks people made are not listed to it. When none fits it answers with the connectors that could
give the need, and `bind` calls `agent.hookMaker` (a person approves that one call). The builder
reads the connector, copies its fixed values from a hook that already calls it (read only), then
creates the hook, adds the call, runs it raw, tries a transform locally until the output has the
need's fields, saves it checked against that run, samples and publishes it.

Run `89e73718` (dev Cast, no `dugout_` hooks before): researcher $0.017, builder made and
published `dugout_hundred_fixture_cards` from `fanxp-seed-api-cricket-schedule` in 14 steps,
$0.08; bind bound 15 props; $0.31 in all. Found there: `bind` called the builder twice, and two
hooks were built (`dugout_hundred_fixtures` is the unused one). A writing child now runs once per
parent run. Then the researcher alone (run `0acc1148`, $0.02) found the built hook.

## The rule

**Our code knows nothing about any API.** No `fixtures`, `match`, `score` or `countdown` in
TypeScript. Adding a new API (news, standings, squads, a sponsor feed) changes no code: the agent
is pointed at a sample response, and what it produces is _data_ (a binding plan, `when`
conditions, at most a transform), which generic code checks and stores.

So there are two kinds of work, and they never mix:

|          | Generic code                                                                     | The agent (model)                          |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| Knows    | the frame's structure, the response's structure, the DSL                         | what the words and values _mean_           |
| Is       | deterministic: same frame + same sample → same answer                            | judgement, run once per section            |
| Produces | facts and checks                                                                 | a binding plan: data, stored with the tree |
| Example  | "these 3 subtrees repeat", "`event_state` is a short string with values seen: R" | "`R` is the variant that says RECENT"      |

**At render time nothing is a model.** The plan is stored, like a layout choice, and applying it is
pure (`applyBindingPlan`, the renderer's `resolveTemplate` and `evaluateWhen`). A recompile of the
same frame applies the same plan. The model runs only when a section is bound for the first time,
or its frame or its API changes.

## The source: a Cast flow

```
GET https://sb.dev-fanxp.sportz.io/cast/api/flow/1cff832f-0cd8-4449-99ea-ec511a033ea8
{ "data": { "1": [ …4 matches ] },
  "meta": { "polling": { "url": "https://sb.dev-fanxp.sportz.io/cricket/v1/schedule?…", "interval": 10 } } }
```

It works for now, and it is a better first source than the raw schedule API:

- **Already shaped by the hook.** `participants[]` with `name`, `short_name`, `logo`;
  `matchcenter_url`; `event_state` (`U`/`L`/`R`); `display_status`; `venue_name`; `event_name`.
  The shaping is in Cast's JSONata, not ours. `fromCastFlow` already peels the `data.1` page key,
  so a tree binds `items`.
- **Scores are not in it.** `participants[].value` is empty. They come from `meta.polling.url`
  (the schedule API: `scores[]` per innings, by `team_id`), joined on `match_id`. That join is the
  platform's polling contract, not business logic: the hook says what to poll and how often. The
  renderer needs one generic step for it (below).
- **Dates** are `5/26/2026T19:30:00+05:30`, not ISO. One parse in `formatDate` for this format
  covers every Sportz API that uses it.
- **Not in it**: tickets link, gender. Blocks that show them are hidden (`when: exists`) or
  bound to tenant config.
- **All 4 matches are results** (IPL 2026 playoffs). See _States the sample does not show_.

## What generic code does (deterministic, domain-free)

**From the frame (Figma IR):**

1. **Repeats.** Siblings with the same subtree signature are one template repeated
   (`proposeCollapse`, `subtree-signature.ts`). Nesting falls out: slides repeat, and inside each
   slide the blocks repeat.
2. **Variants.** Instances of the same component with different `componentKey`s at the same place
   in the template are variants of one item. Their subtrees differ; code lists what each one has
   that the others do not (its own texts and images).
3. **Holes.** Every text, image and link in the template is a candidate for a binding, with the
   design's placeholder value ("21 JULY", "166/5", "RECENT") as a hint.

**From the response:**

4. **The shape.** A schema inferred from the sample: types, lists, which paths are present on
   every item and which on some, short strings with few distinct values (enum-like), URLs,
   image URLs, date-like strings, numbers written as strings.
5. **Joins the source declares.** A flow's `meta.polling` (and later any `merge` a source
   declares) is applied by key, generically, so the agent sees one item with both halves.

**Checks (the gate before anything is stored):**

6. **Every bound path exists** in the shape, with a type the prop accepts (B1–B7, `contract.ts`).
7. **Every variant is reachable**: some value of the field its `when` tests selects it, and no two
   variants draw at once for the same item.
8. **Scenarios render.** From the shape alone, code makes variations of a real item: each
   enum value, each optional field missing, lists of 0, 1 and many, the longest string seen. Each
   is rendered; code checks that exactly one variant draws, nothing is empty that the design fills,
   and nothing overflows its box.

None of this has a word about sport in it. A news grid, a standings table and this strip go
through the same code.

## What the agent does (judgement, stored as data)

For each hole and each variant, from the design's words and the response's values:

- **Bind** each hole to a path: the "166/5" text to `participants.0.value`, the crest to
  `participants.0.logo`, "21 JULY" to `start_date | date:"DD MMMM"`.
- **Pick each variant's condition** from an enum-like field: the block that says RECENT draws when
  `event_state` is `R`, UPCOMING when `U`. LIVE is `L`, drawn with the RECENT layout.
- **Say what the frame groups that the data does not.** The design puts two matches under one
  date. That is a grouping of the list (see _DSL_), chosen by the agent, applied by code.
- **Only if the hook's shape cannot give what the design shows**, propose a transform (JSONata).
  Today it runs in the `static` source. With the Cast layer it becomes a draft hook, behind
  approval. It is never TypeScript in this repo.
- **Ask a person** for what neither the frame nor the data says (a tickets link per tenant).

Its output is a `BindingPlan` (the format exists in `bind.ts`), extended with `when` per variant
and grouping. Code runs checks 6–8 on it; a failure goes back to the model as a tool result, as a
refused override does in `frame-match`.

## States the sample does not show

One sample has `event_state` `R` only. Generic code can vary what it saw. It cannot know that
`U` and `L` exist. Two answers, in order:

1. **Now:** the agent states each enum's full domain when it picks the conditions (`U`, `L`, `R`),
   and code builds those scenarios from a real item. A person sees the list at approval.
2. **Later:** Cast gives each hook an output schema with enums. Then the domain is a fact, not a
   judgement. (Already an open ask in the dynamic SDUI spec.)

## DSL and renderer changes (all generic)

1. **A `data` block on the tree**: named sources, `source.kind` a closed union. `cast-flow`
   (a flow id, fetched server-side; its `meta.polling` honoured) and `static` (a saved response,
   for previews and evals). Every top-level path a binding reads needs a declared source.
2. **Variants in one template**: each variant's subtree behind a `when`. A merge step builds the
   template from the instances that drew each variant.
3. **Grouping on `Repeater`**: `groupBy: "{start_date | date:\"YYYY-MM-DD\"}"` makes a list of
   `{ key, items }`, so slides repeat over days and blocks over the day's items. A design
   concern, like `slice`, so it belongs in the tree.
4. **Nested repeaters**: an inner `over` reads the outer alias (`day.items`).
5. **`Countdown` as a container of designed nodes.** Today it is a leaf that draws its own digits,
   which breaks "looks in the DSL". It becomes a container that ticks and provides
   `{countdown.days}` etc. to the designed texts inside it (the same pattern as carousel
   controls). Which texts are the countdown is the agent's call, like any other binding.
6. **Bound non-text props**: `initialSlide`, `src`, `href`.
7. **Polling**: a source's `refresh` from `meta.polling` (interval), through our BFF route, the
   joined half refetched. This is phase 5 of the dynamic SDUI plan, and comes after binding works.

## Agent architecture

**A new agent, `bind`, run by a program after `frame-match`. No subagent yet.**

- **Separate from `frame-match`.** Different job, tools, skill and eval. The dynamic SDUI plan splits
  agents by job (intent, binding, repair).
- **Chained by code.** One Send is one program (ADR 0017): `frame-match` → `bind` → publish. The
  order is fixed, so code runs it. Each is its own run, linked by `parent_run_id`, evaluated alone.
- **The subagent comes with the Cast layer.** Finding which hook feeds a card, across a tenant's
  hooks and APIs, is an open-ended search that would flood `bind`'s context. That is a read-only
  `hook-finder` subagent (harness-orchestration ticket 07). Until then the flow id is given.

```
Send ─► frame-match ─► bind ─────────────────────────────────────► publish (approval)
                      code: repeats, variants, holes, shape
                      model: plan (paths, when, grouping)
                      code: checks 6–8, scenarios ── refused ──► model
                      ▲
                      later: hook-finder subagent finds the flow
```

## Order of work

1. **Shape and scenarios.** Schema inference from a sample; scenario generation; the polling join
   for a flow. Unit-tested on this flow and on the news-grid fixture: two unrelated APIs, one code
   path.
2. **DSL + renderer.** `data` block (`static`, `cast-flow`), variants under `when`, `groupBy`,
   nested repeaters, `Countdown` as a container, bound non-text props, the date format.
3. **The strip bound by hand.** A hand-written plan against the flow, rendered for every scenario.
   This is the reference answer for the agent's eval, not code.
4. **Frame facts.** Variant detection and merge, holes with their placeholder hints.
5. **The `bind` agent.** Tools (`data.shape`, `data.try` for a plan, `data.scenarios`), skill,
   eval against step 3 _and_ against the news grid, then the program that runs it after
   `frame-match`.
6. **Then Cast:** writes behind approval, `hook-finder` subagent, hook output schemas.

## Open questions

- **Scores.** Is joining the flow with its `meta.polling.url` on `match_id` how production does
  it, or should the hook's JSONata fill `participants[].value`?
- **Enums.** Can Cast publish an output schema per hook (with `event_state`'s values)?
- **Tickets and gender.** Tenant config, or fields a hook should add?
