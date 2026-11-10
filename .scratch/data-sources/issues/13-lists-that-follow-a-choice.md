# 13 · A list follows the page choice that filters it

Status: resolved (2026-11-10; the carousel follow-up is done; SCRE's port is in progress in its own repo)
Type: task
Blocked by: none

## What

A design often has a choice (tabs, a toggle, a segmented control, a filter: WOMEN/MEN,
RESULTS/UPCOMING, ALL/NEWS/VIDEOS, a season picker) and a list it filters. Frame-match publishes
the choice (`_page.<key>`, ADR 0032), but nothing makes the data and the binding meet it:

- hook-maker shaped the data as side-by-side lists (`{ women: […], men: […] }`, run `d79c8f05`);
- the plan can collapse cards over one list only, so data-bind bound `squad.men` and the tabs
  changed nothing ("the same cards can't be collapsed over two lists").

The DSL can already filter a list by a choice: an item's `when` with
`{ path: "item.gender", eqPath: "_page.squad" }` (`packages/dsl/src/page.ts:16`).

## Change

1. **The need says which choice filters the list.** `draftNeed` (`agents/data-bind/src/facts.ts`)
   adds `filterBy: { key, options }` for each list a choice in the same slot governs: the choice
   is drawn above or beside the list, and the list's slot writes it (frame-match's `page_choices`).
2. **hook-maker returns one list with a field whose values are the choice's options**
   (`gender: "women" | "men"`, `state: "results" | "upcoming"`), lower case as the choice writes
   them, and says the field in `covers` (`filterBy → items[].gender`). When the feeds come one per
   option (one URL per gender), the transform tags each feed's items with its label and
   concatenates them. Instructions and the skill: side-by-side lists only when no choice filters
   them.
3. **data-bind binds the filter.** When the need has `filterBy` and the data has the field, the
   plan's collapse gets `when: { path: "<item>.<field>", eqPath: "_page.<key>" }`. `bind.try`
   reports a list a choice governs that is not filtered by it, and a filter whose values never
   match the choice's options ("the data says `Women`, the tabs write `women`": use a `lower` pipe
   or map it in the transform).
4. **Data already shaped side by side** (a hook a person chose): allow a collapse's `over` to read
   the choice (`over: "squad.{_page.squad}"`) in the DSL, so existing hooks work too. Validator:
   every option names a list that exists.

## Done when

- Tests with three shapes, none from the Team frame:
  - tabs over a news list filtered by `category`;
  - a toggle over results and upcoming matches filtered by `state`;
  - a two-option toggle over two side-by-side lists, using the `over` form.

  Switching the choice in the renderer changes the items drawn.
- `bind.try` test: a governed list left unfiltered is a problem.
- `pnpm agent schemas` updated (`Need.filterBy`).

## Pointers

- `packages/dsl/src/page.ts`, `packages/dsl/src/bind.ts` (collapse), `agents/data-bind/src/facts.ts`
  (`draftNeed`, `dryRun`), `agents/hook-maker/src/agent.ts` (`Need`, instructions),
  `agents/hook-maker/skills/hook-maker.md`

## Comments

2026-11-09: done. DSL: `over: "squad.{_page.squad}"` (`overChoice`, `overFor`); the contract check wants every option to name a list; the renderer draws the list of each option, gated on it, so the browser shows the chosen one (ADR 0032's PageGate). Agents: `bind.load`'s `draftNeed` has `filterBy` (the choices the section draws); hook-maker's `Need.filterBy` makes the output one list with a field holding the option (`filterBy → items[].field` in `covers`, checked by code: every option must have items); `bind.try` faults a governed list drawn whole and an option no item holds (`choiceProblems`), and now also reads the choices the frame's own tabs write (before, only a slot's did). Tests: three shapes none from the Team frame (news by category, results/upcoming by state, side-by-side by `over`) in `packages/renderer/tests/page-over.test.ts`, `packages/dsl/tests/page-over.test.ts`, `agents/data-bind/tests/choices.test.ts`. The server draws the option the page starts at; the other is revealed in the browser, as every PageGate panel is. SCRE has its own DSL copy: port `overChoice`/`overFor`, the contract check and the Repeater branch by hand.

2026-11-09 review, reopened:
- **A choice another section writes draws an empty list.** `packages/renderer/src/components/Render.tsx:307-313` and `packages/dsl/src/contract.ts:311-327` take options only from `select` nodes in the same tree, never `ctx.page` or the data's keys. ADR 0032's case (toggle in one section, list in another): `over: "table.{_page.squad}"`, data `{table:{women:[…],men:[…]}}`, page `squad: men` draws nothing; the contract reports B2. Confirmed. Options come from the page's known choices (`page_choices`) and the data's keys; draw the chosen one even when no option list is known.
- **"ALL" draws nothing.** `when: {path:"it.category", eqPath:"_page.tab"}` with `all` selected matches no item. Confirmed. An option that names no value in the data (all, everything, both) shows every item: say so in the DSL (an option marked `all`, or `eqPath` that passes when the page value is an option no item holds), generically.
- **Contract and renderer disagree inside another Repeater** (`packages/dsl/src/page.ts:96`): `overFor` looks the list's parent up in root data, the renderer in the item scope. Confirmed.
- **An option value with a dot** (`"2025.26"`) makes path `seasons.2025.26` (`page.ts:100`): read the key as one segment.
- **Options that normalise alike draw the list twice** (`Render.tsx:308-329`): dedupe on the normalised value.
- **Choice problems can't be kept, and match any section's choice** (`agents/data-bind/src/choices.ts:124`, `tools.ts:1403`): another section's home/away toggle faults a fixtures list whose items hold `venue: "Home"`. Only a choice the slot draws, or one whose options cover the field's values and is placed with the list, governs it; and a person or the model can keep it with why.
- `hook-maker` `fit.ts:208-217`: `choiceKey("Men's")` is `mens` while the skill and instruction 0a say `men`: one rule, used by code, the skill and the instruction alike.
- Tests: switching the choice in the browser (PageGate) is not tested; add a cross-section case and an ALL case.

2026-11-10, review fixed: `over: "x.{_page.k}"` takes its options from the data's own list keys (normalised), so a choice another section writes draws its list; the contract checks the Repeater's own scope (agrees with the renderer inside another Repeater); dotted option keys are one segment; options that normalise alike draw once. **ALL rule** (`packages/dsl/src/page.ts`): an option whose value no item holds shows every item (all, everything, both, or a key not set yet); for `eqPath` filters it works through `_each`. A side-by-side option naming no list is a B2 warning. Exports `overList`, `overLists`, `itemScope`, `heldBy`, `EACH_SCOPE`; `checkBindings(tree, data, { choices })`. data-bind's `choiceProblems` faults only a choice the frame or slot draws (or one a slot reads whose options cover the field's values), never an ALL option, and can be kept; hook-maker's choice values use `pageValueOf`. Tests: Playwright browser switch, cross-section, ALL (standings, news, venues).

Follow-up, not done: a carousel whose Repeater reads a choice draws only the starting option (no switching in the browser). SCRE's DSL copy needs the port.

2026-11-10, carousel follow-up done: a Carousel whose Repeater has `over: "x.{_page.k}"` draws a group of slides for each option's list and one for a value that names none (ALL), each slide carrying the conditions it shows at (`data-fos-gate`); the server hides those the page is not at, and `CarouselRoot` re-gates them as the choice changes (`packages/renderer/src/carousel/gate.ts`), telling Swiper (which skips hidden slides) to measure again (`fos-carousel-refresh`; a looping rail rebuilds its clones). Tests: `packages/renderer/tests/carousel.test.ts` ("a carousel whose Repeater follows a page choice": markup, and a real Swiper in Chromium switching from two results to three upcoming cards). A carousel over ONE list filtered by an item field (`when` with `eqPath`) is not covered: its filtered-out slides draw empty.
