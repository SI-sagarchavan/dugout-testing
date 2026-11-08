# 02 · Declared questions

Status: resolved
Type: task
Blocked by: 01

## What

An agent says which questions it asks, so the same question has the same id every time.

- `AgentSpec` (`packages/contracts`) gains `questions: Record<id, { scope: "tenant" | "section"; fact?: string; about: string }>`. `fact` is a semantic key (`media.player-photo`, `layout.carousel.loop`). A section question may name one too: what promotion proposes.
- The built-in `ask` tool lists the agent's declared ids with `about` in its description. An id that is not declared is still asked, and is not learned (the run record keeps it).
- Questions a tool writes in code (`AwaitingAnswers`) use declared ids too.
- Declare them:
  - `frame-match`: `items`, `autoplay`, `loop`, `platform` (section; `loop` and `autoplay` name `layout.carousel.*` facts).
  - `data-bind`: `photo_url` (tenant, `media.player-photo`), `card_template` (section), `badge_meaning` (section), `toggle_filter` (section), `image_domain` (tenant, `media.image-domain`).
  - `hook-maker`: `hook_choice` (section).
- Skills (`agents/*/skills/`) name these ids where they tell the model to ask. The Nov 7 / Nov 8 ids `photos`, `photo_url`, `build_or_use`, `build_mode`, `card_shape`, `icon_badge`, `toggle` collapse into the list above.

## Done when

- `ask` with a declared id and with an undeclared one both work; a test checks an agent's skill only names declared ids; `pnpm agent schemas` is current.

## Comments

2026-11-08: `DeclaredQuestion` and `AgentSpec.questions` (`packages/contracts`); `ask`'s description lists the declared ids (`askDescription`, `packages/core/src/loop.ts`); the run stamps a declared question with `about` (`withAbout`), a child's travels up as it is. Declared: frame-match `kind`, `items`, `autoplay` (`layout.carousel.autoplay`), `loop` (`layout.carousel.loop`), `platform`; data-bind `image_domain` (tenant, `media.image-domain`), `picture_url`, `content_mismatch`, `item_count`, `countdown`, `card_template`, `badge_meaning`, `choice_filter`; hook-maker `hook_choice`. Skills name them (`bind.md`, `hook-maker.md`); `agents/data-bind/tests/decisions.test.ts` checks the skill names exactly the declared ids. Changed from the ticket: `photo_url` became `picture_url` with no fact (a club's pictures are of more than players), and the toggle question is `choice_filter`. Schemas unchanged (`pnpm agent schemas` test passes).
