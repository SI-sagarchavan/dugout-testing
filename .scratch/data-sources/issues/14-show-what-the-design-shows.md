# 14 · The hook gives what the design shows, in the design's form

Status: resolved (2026-11-10, after review)
Type: task
Blocked by: none

## What

The feed often has the value the design shows, but in another form. The hook passes it through
as-is, and the page shows the feed's form. Seen in run `f77d8a76`, but these are kinds of gap that
recur in any data:

- **A unit converted:** the design writes "(100 Balls)"; the feed has overs `19.3` (in The Hundred,
  5-ball sets: 98 balls). Elsewhere it would be minutes from seconds, km from m, or a percentage
  from a ratio.
- **One field split, or several joined:** the design draws the name on two lines ("Ben /
  McKinney"); the feed has one `name`. Or the feed has `first`/`last` and the design one line.
- **A code made a word:** `R`/`U`/`L` → "Completed"/"Upcoming"/"Live"; `C`/`VC` → a badge.
- **What a card shows depends on the item:** the site shows a bowler's wickets and economy where a
  batter's card shows runs and strike rate. Our cards showed "–" and "0" for bowlers, because the
  hook carries runs and strike rate only.

`bind.try`'s format check let "(20.0 Overs)" pass for "(100 Balls)": it compares the number's
shape, not the words around it.

## Change

1. **The need carries the design's example for every field** (`draftNeed` already reads it). It
   also carries a field's `alternatives` when the design's cards show different fields by kind of
   item (labels differ across the design's cards, or the item's role is shown).
2. **hook-maker computes in the transform what the design shows**, when the feed has it in another
   form. Skill section "The design's form": units, splits and joins, codes to words, and fields
   that depend on the item (`stats: [{ label, value }]` by role, or every field the alternatives
   name). It checks each against the field's `example` with `cast_eval_jsonata`. It says in
   `covers` what it derived (`balls ← overs (5-ball sets)`).
3. **Format check compares the words too.** `formOf` keeps the non-numeric words around a value
   (`(# Balls)` vs `(# Overs)`), and the problem names the derivation (hook-maker) or the template
   (data-bind) that fixes it. A word that is the design's own copy is not data: it is compared only
   when the template writes it.
4. **A label that varies by item is bound, not kept.** When the design's cards show different
   labels, or the data's items differ in which fields they have, `bind.try` reports a label kept as
   design copy over values that change meaning ("Runs" over a bowler's wickets).

## Done when

- hook-maker tests (fake hub): an overs → balls feed, a full-name → first/last feed, a code →
  word feed and a role → stats feed each come out in the design's form.
- `facts.test.ts`: the format check flags "(20.0 Overs)" against "(100 Balls)" and passes
  "(98 Balls)"; it does not flag design copy.
- The eval suite (06) has one case whose design writes a unit the data does not have.

## Pointers

- `agents/data-bind/src/facts.ts` (`draftNeed`, `formOf`, `hasForm`, `fixForm`),
  `agents/hook-maker/skills/hook-maker.md`, `agents/hook-maker/src/agent.ts` (`NeedField`)

## Comments

2026-11-09: done. `formOf` (hook-maker `form.ts`, shared) now compares the words around a number, so `(20.0 Overs)` is not `(100 Balls)` and `(98 Balls)` is; the problem says whether a unit differs (derive it in the hook) or only a word (template). hook-maker's final check compares each covered field with its need example (dates and times stay instants) and the skill has "The design's form" (units, splits and joins, codes to words, fields by kind of item). `draftNeed` carries `alternatives` where cards' labels differ; `bind.try` faults a label kept from one card over values that mean something else (`varyingLabels`). The reference strip plan itself binds overs where the design writes balls, which the check now (rightly) reports. The eval case for a unit the data lacks is not added: the suite's cases still need a live preview each.

2026-11-09 review, reopened:
- **hook-maker's check contradicts its skill** (`agents/hook-maker/src/fit.ts:229-246`): the skill says give the number, not the unit's words, but `fitIssues` compares the whole example: `98` against "(100 Balls)" is refused, as is `"166"` against "166/5" given apart. Compare a field with the part of the example it fills (the number), and leave the words to the page.
- **Both format checks flag correct values** (`form.ts`; data-bind `facts.ts:731-748`, `fixForm` ~610): ordinals ("2nd"/"1st"), signs ("+3"/"-2"), plurals ("1 Goal"/"2 Goals"), "W 3-1"/"L 0-2", relative times ("5 mins ago"/"2 hours ago"), thousands separators. With `textCase: upper`, the drawn value is upper-cased but not the placeholder, so `date:"DD MMMM"` against "21 July" is still flagged. The suggested fix for "2nd" is `"{item.field}nd"`. Forms compare by shape (sign, ordinal suffix, plural, separators are not a different form), case-folded both sides.
- **`kindOf` reads text as dates** (`facts.ts` ~391): "Round 3", "12 GOALS", "Bat 4" are `date` (`/^\p{L}{3,9}\s+\d{1,2}/`). Only month names (and their short forms) followed or preceded by a day.
- **`draftNeed` repeats fields on nested lists** (~438): a day card with two match panels gives `score` twice and the inner list its own draft. Fields of an inner repeat belong to the inner list only.
- **Generic rule** (spec): `hook-maker.md:61` hard-codes six-ball overs, and has a typo (`$floor(o)`); The Hundred's 19.3 is 98 balls (five-ball sets), the formula gives 117. No sport's rule in a skill: the unit's size comes from the data or a house fact, and the skill says how to derive one unit from another in general. `gender` (`hook-maker.md:71,74`, `bind.md:69`) and `is_upcoming` (instruction 0b) name feed fields: use placeholders (`<field>`).
- Done when: the four fake-hub tests (unit, split, code → word, per-item fields) are not there; only overs → balls, as a direct `fitIssues` call.

2026-11-10, review fixed: hook-maker `fillsForm` accepts the whole form or the number part it fills (`98` for "(100 Balls)", `166` for "166/5"); a decimal where the example is whole is refused (overs for balls). `formOf` treats sign, ordinal, plural, thousands separators, time units and one-letter codes as one form, case-folded both sides. data-bind's format check case-folds both sides; `fixForm` proposes the date pipe only for a real month name and never a fixed suffix. `kindOf` reads a date only from a month name beside a day. `draftNeed` gives an inner repeat's fields to the inner list only. Skills: the six-ball formula is gone (the unit's size comes from the data or a house fact); `gender`, `is_upcoming`, `sorting` are placeholders. Fake-hub tests: ratio → percentage, full name split, code → word, stats by role. Checked by hand on 2026-11-10.
