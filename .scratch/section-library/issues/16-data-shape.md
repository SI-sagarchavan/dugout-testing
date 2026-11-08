# 16 · A section's data shape

Status: resolved
Type: design + task
Blocked by: 15

## What

A section's data, kept as its shape and never its values, so another tenant can fill the same design with its own data.

- From the binding plan data-bind applied to the preview: which layer shows which field, what repeats, which variants exist; and the Cast hook's output schema.
- Kept on the row as the data contract, and in words in the text that is embedded and searched ("each item: home crest, away crest, kick-off time, venue; repeats; live and upcoming variants"), so a search can name the data a section shows.
- For another tenant: hook-finder looks for a hook of that shape in its Cast (hook-maker builds one when none fits), or sample data is made from the schema for a preview.

## Done when

- A previewed section carries its data shape, and a search for "a section showing a league table" finds one by it.

## Comments

2026-11-07: it never needed the DSL. A preview's run keeps its binding plan and the data it bound (`planArtifactId`, `dataArtifactId`, also `plan=` and `data=` in the link), and the plan names Figma layer ids, which the IR places in sections. `dataShapeOf` (`src/data-shape.ts`, pure, `tests/data-shape.test.ts`): a positional bind (`news.articles.0.title`) and a collapse (`over`, `slice`, `members`) are both the list `news.articles`; items drawn is the highest slice end, member count or position; nested lists resolve through the outer alias (`fixtures.days[].matches`); templates' refs too; a field's type from the prop (`src` is a picture), the pipe (`date` is a date) and the bound value (number, ISO date, boolean, text), the value itself never kept. Kept in `data_shape`, in the searched words ("Data: a list of 5 news articles, each with image (picture), title (text), read time (number), published date (date)."), and shared: another club reads the field names and types. Live on `sb`'s news section, from section-builder's and data-bind's runs.

Left, elsewhere: the Cast hook a plan was bound from is not in data-bind's output, so it is not kept (data-bind would have to say it); another tenant filling the shape from its own Cast is the composer's (ticket 10); a section bound by more than one run keeps the latest run's shape.
