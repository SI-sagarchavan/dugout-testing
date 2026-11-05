# 04 · Structural summary and caption

Status: ready-for-agent
Type: task
Blocked by: 03

## What

- `summarize(tree)`: pure code that describes a section's structure in one or two lines ("horizontal carousel, 4 cards; each card: image, crest, crest, score, date, button"). Repeats are counted, not listed; content props (`CONTENT_PROPS`) are left out.
- `caption(crop, summary)`: one call to a vision model in `config/models.json`, returning `{ caption, kind, tags }` as structured output. `kind` is from the closed list in the spec. Tags are 3–8 short phrases a person would search with. The prompt says to describe the component, not the content shown in it.

## Done when

- Summaries of the eval frames' sections are pinned in a test.
- Two sections with one signature and different content get the same summary.
- A live test captions three crops and each caption names the section's kind correctly.
