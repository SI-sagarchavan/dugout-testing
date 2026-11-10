# 15 · Which items, in what order, grouped as the design groups them

Status: resolved (2026-11-10)
Type: task
Blocked by: none

## What

A hook returns the feed's items in the feed's order, cut to `page_size`. The design means
something more specific.

- **Order and selection.** "THE ROAD AHEAD" with 3 cards means the next matches, then the latest
  results. The schedule feed was `sorting=asc`, so the hook gave the season's first three results
  (Jul 22, 22, 25). hook-maker even said so ("the first 3 are the oldest results… I didn't inspect
  the field values"). The same goes for any dated list: latest news, recent videos, upcoming
  events.
- **Grouping.** The design's card holds a women's and a men's match of the same day (a second inner
  panel). The hook gave one match per item, so the second panel was hidden. Any design whose card
  holds several items (a day of fixtures, a category of articles) has the same gap.

## Change

1. **The need says the order and the grouping.**
   - `draftNeed` adds `groupBy` when the design's repeated card holds an inner repeat, or two
     instances of one shape (two match panels in one card). The key is the field the inner items
     share, found by data-bind from the data: the date, the category.
   - The need also gets `order`: `soonest-first` (upcoming), `newest-first` (results, news),
     `upcoming-then-latest` (a fixtures strip that shows both), or `as-is`. data-bind picks it from
     the list's kind and the design's words ("AHEAD", "LATEST", "RECENT"), with `as-is` only when
     nothing says otherwise.
2. **hook-maker meets it.** It sets the connector's own sort and filter inputs where it has them
   (`sorting`, `is_upcoming`), and otherwise sorts, filters and groups in the transform. It cuts to
   `page_size` after sorting. It must run the hook and read the dates of what came back.
3. **A code check of the order.** `bind.try` (and hook-maker's check) reads the date field of each
   item and reports when they are not in the need's order. It also reports when the cut leaves only
   past items for a list that shows upcoming ones, while the feed has upcoming items.

## Done when

- Tests with three needs: upcoming-then-latest fixtures, newest-first articles, and fixtures
  grouped by day, each on a fake feed sent in the wrong order. The output comes back in the need's
  order and grouping.
- `facts.test.ts`: a list in the wrong order is a problem.
- The eval suite (06) grades order for its dated lists.

## Pointers

- `agents/data-bind/src/facts.ts` (`draftNeed`), `agents/hook-maker/src/agent.ts` (`Need.groupBy`,
  instructions), `agents/hook-maker/skills/hook-maker.md` ("The output's shape")

## Comments

2026-11-09: done. `Need.order` (and `groupBy`), `draftNeed` reads `order` from the design's words and `cardHolds` from inner repeats; hook-maker's skill and check (`orderIssues`, field named in covers as `order → path`); `bind.source` takes `order` and `bind.try` reads the dates of the plan's list against it (`orderProblems`). Not built: the check that a cut leaves only past items while the feed has upcoming ones (the hook's output is all code sees of the feed); the eval suite's order grader.

2026-11-09 review, reopened:
- **The order check never fires in a real run** (`agents/data-bind/src/tools.ts:1398`): it is given the hook's raw output (`s.sample`) but looks up `${c.over}.${f.path}` in the named data; a path with a pipe never matches. Confirmed: wrongly ordered news gives `[]`. Give it the named data and the field's path without pipes.
- **hook-maker's `orderIssues` refuses what its skill builds**: with `filterBy`, the skill joins each option's feed (`$append`), each sorted; the check over the joined list reports "the dates go back and forth". Check order within each option's items when the list has a `filterBy`.
- **Dates read with `Date.parse`**: yearless "21 July" is 2001; "07/11/2026" US order; epoch seconds as ms; a live match an hour old fails soonest-first. Use the DSL's date reading (ticket 10) and allow items already started for soonest-first.
- **`orderOf` reads every word in the frame** (`tools.ts:1100`): a "Next" arrow gives `soonest-first`, "Last name" `newest-first`, for every list. Read the words of the list's own section (its heading), and only words that name time ("upcoming", "latest", "recent", "ahead", "results"); no order when nothing does. With an order, an undated list must not fail hook-maker's fit (`order → path` cover required only when the items carry a date).
- Not built, still to do: the check that a cut leaves only past items while upcoming exist (code sees the output's states: flag when the need's order wants upcoming and every item is past while the source's `missing` or the output shows none); a fake-feed test sent in the wrong order and grouped by day.

2026-11-10, review fixed: `orderProblems` reads the named data, paths without pipes, dates with `@fanos/dsl` `readDate` (unreadable skipped); it fires through the real `bind.try` (`agents/data-bind/tests/try.test.ts`). hook-maker's `orderIssues` checks each option's items apart when the list has `filterBy`, reads dates with the DSL, and needs no `order →` cover for an undated list. `orderOf` reads only time words from the list's own heading (`sectionWords`), and orders only a list that shows a date or time. Soonest-first accepts an item started up to 24 hours ago (a chosen number, not from the ticket). Fake-feed test: fixtures grouped by day, sent in the wrong order.

2026-11-10, the last two done. **Past-only check:** a list that wants what is next (`soonest-first`, `upcoming-then-latest`) and holds only past items is a problem. In `bind.try` (`orderProblems`, keepable with why: "nothing upcoming exists"; it names sorting before the cut and settling `data_source`) and in hook-maker's final check (`orderIssues`, which takes the answer's `missing`: it passes when `missing` says nothing is upcoming). Code sees only the output, not the feed, so it cannot know whether upcoming items exist: it asks, and the answer is a fix or a stated `missing`. **Order grader:** `dataOrder` in `packages/evals/src/data.ts` (case field `expect.order`; `articles-list` expects `newest-first`); the outcome carries each dated list's item times (`datedLists` in `agents/data-bind/evals/extract.ts`, dates read with the DSL's `readDate`) and the time it was judged at. Tests: `packages/evals/tests/data.test.ts`, `agents/data-bind/tests/{facts,eval-extract}.test.ts`, `agents/hook-maker/tests/fit.test.ts`.
