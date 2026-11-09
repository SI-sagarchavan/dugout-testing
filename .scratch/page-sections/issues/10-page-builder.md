# 10 · A whole page: bands in parallel, stitched

Status: needs-triage (later: after 09 holds on several frames)
Type: grilling
Blocked by: 09

## What

A Handoff of a whole page. The finder (ticket 02) gives its bands; each band is one
`section-builder` run (keyed child, ticket 06), several at once; the page is put back together in
the bands' order, each band one `surface_section` (SCRE, renderer v2). Each choice stays with the
slot that draws it (ticket 05); a band reads another band's choice only when that was asked for on
purpose. Check key clashes across bands: two bands' slots named alike need different keys.

To settle before building:

- Host: a `page-builder` agent with a pipeline (ADR 0025) over keyed `section-builder` children
  (depth 3: page → section → bind → hook-maker; budgets), or ADR 0017 programs once the worker runs
  them.
- Approvals: one for the page, covering every band's builds, and questions from several bands in
  one pause.
- Threads (ADR 0031): one thread per page, or per band joined to the page's.
- Section library: a band already built for this tenant (same signature) is reused, not rebuilt.
- Cast budget across bands.
- What "stitched" checks: the page's screenshot against the stacked previews.

## Found while building 02

- A short row of text at the top of a page (a page header or nav, such as `D_Header` on the
  `container` page 35:9853) counts as a heading under 02's rule 2 and joins the band below it. A
  section's heading row is a title plus at most tabs and a button; a page header holds a logo
  and several links. The finder needs to tell them apart before whole pages are handed off. Add
  `container` (35:9853) as a sections eval case once its answer is settled.
- `packages/library/tests/indexer.test.ts`'s page fixture was rewritten for 02 (taller header,
  text in its footer), because the old one, a thin header, now read as a heading. Recheck that
  fixture when the rule above is added.
