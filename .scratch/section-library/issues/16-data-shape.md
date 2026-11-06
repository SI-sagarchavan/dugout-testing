# 16 · A section's data shape

Status: ready-for-agent
Type: design + task
Blocked by: 15, the DSL

## What

A section's data, kept as its shape and never its values, so another tenant can fill the same design with its own data.

- From the binding plan data-bind applied to the preview: which layer shows which field, what repeats, which variants exist; and the Cast hook's output schema.
- Kept on the row as the data contract, and in words in the text that is embedded and searched ("each item: home crest, away crest, kick-off time, venue; repeats; live and upcoming variants"), so a search can name the data a section shows.
- For another tenant: hook-finder looks for a hook of that shape in its Cast (hook-maker builds one when none fits), or sample data is made from the schema for a preview.

## Done when

- A previewed section carries its data shape, and a search for "a section showing a league table" finds one by it.
