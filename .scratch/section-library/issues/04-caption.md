# 04 · Structural summary and caption

Status: in progress
Type: task
Blocked by: 03

## What

- `summarize(node)`: pure code that describes a section's structure from its IR in one line. Repeats are counted, not listed; text layers' names and Figma's default names are left out, so content never gets in.
- `caption(picture, summary)`: one call to a vision model in `config/models.json`, returning `{ caption, kind, tags }` as structured output. `kind` is from the closed list in the spec. Tags are 3–8 short phrases a person would search with. The prompt says to describe the component, not what it shows today. Written back with `SectionLibrary.describe`.

## Done when

- Summaries of the eval frames' sections are pinned in a test.
- Two sections of one shape with different content get the same summary.
- A live test captions three pictures and each caption names the section's kind correctly.

## Comments

2026-11-06: `summarize` is in (`packages/library/src/summary.ts`, `tests/summary.test.ts`). Left: the captioner, and pinning summaries on the real eval frames (with ticket 03).

2026-11-06: the captioner is in (`src/caption.ts`, `createVisionCaptioner`, haiku through `describeImage`). Tried live on the sections of three Handoffs: each named its kind (news, news list, fixtures) and none named a team, player or headline. Left: a live test in the suite, and pinning summaries on the eval frames.
