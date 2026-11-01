A card is one flat SDUI tree plus a data object. The pipeline renderer draws it. The checker is the pipeline validator, so a tree it rejects is not finished.

## Wire format

There is no example tree. Each node has `id`, `parent`, `idx`, `type`, `src` and `props`. The tree is `{ schemaVersion, nodes }` with schemaVersion `1.0.0`.

- Exactly one node has `parent` null. Every other `parent` is an existing `id`.
- A parent's children have `idx` 0, 1, 2 with no gaps.
- `src` is unique on every node. Use `synthetic:<cardId>:<n>` with a new n per node.
- `id` is lowercase letters, digits and underscores.
- `cardId` is the one on the run input.
- On the Figma path, keep every node the Figma tree already has.

## Data

`data` is an object with `match`. `match` is an object of strings. A binding `{match.title}` reads `data.match.title`.

- Every `{match.key}` in a `content` must be a key of `data.match`.
- Put the words that change (names, dates, venues, kickers) in `data.match`. A label such as `Kickoff` can be a literal `content`.
- Do not use an ISO date. Write `6 Nov 2026` or `18:30`.
- Do not use pipes.

## Nodes you may emit

The renderer paints these. Do not emit any other type.

- `Stack`: a row or a column. `direction` is `column` or `row`. `gap` is a space token. `align` is `start`, `center`, `end` or `stretch`. `justify` is `start`, `center`, `end` or `between`.
- `Text`: `content` and `style` are required. `tone` is a color token. `textCase` is `upper` when the design shows capitals and the stored words are not. `align` is `start`, `center` or `end`. `as` is `h2` for the main names and `p` otherwise.
- `Divider`: `orientation` is `horizontal` or `vertical`. `tone` is a color token.
- `Box`: a surface with no layout of its own.
- `Overlay`: children are placed with `place.anchor`. Use a `Stack` instead unless the brief needs overlapping layers. A row of cards is a `Stack`. An `Overlay` whose children are all placed has no height, and `clip` then hides the cards.
- `Image`: only when the brief gives a URL. `src`, `alt` and `fit` (`cover` or `contain`) are required.
- `Icon`: keep an Icon the Figma tree already has. Do not invent an icon name. A circular badge in a screenshot is not an Icon.
- `Button`: use one when the description or the Figma tree shows a button. `label`, `variant` (`filled`, `outline`, `link`, or `no-padding`), `styleN` (`1`, `2`, or `3`), `size` (`sm`, `md`, or `lg`), and `action` are required. A navy button is `filled` with `styleN` `2`. A light outline on a dark header is `outline` with `styleN` `3`. When the screenshot shows no destination, `action` is `{ "kind": "none" }`.

## Tokens

Use only these. A name that is not in this list fails the check.

Space: `space.2_5`, `space.3`, `space.4`, `space.5`.

Type: `type.body_xs_bold`, `type.body_sm_bold`, `type.body_sm_regular`, `type.body_md_bold`, `type.h1_bold`, `type.h3_bold`.

Color on `surface.fixture_shell` (light grey): `color.text_main_high` for names, `color.text_main_sec` for a kicker, `color.text_main_low` for a small word such as vs, `color.core_neu_400` for a divider.

Color on a navy plate (`surface.stat_strip`, `surface.date_strip`, `surface.button_filled_style_2`, `surface.video_card`): `color.text_invert_high` for white words, `color.text_sec_high` for a pale label.

Red scores and a red kicker use `color.text_main_prim`.

Surfaces: `surface.fixture_card` for a white card, `surface.fixture_shell` for a light grey plate, `surface.date_strip` for a vertical date ribbon, `surface.tag_gender` for a MEN or WOMEN pill, `surface.button_filled_style_2` for a navy button plate, `surface.video_card` for a dark navy header, `surface.stat_strip` for a blue fact strip. A Figma name such as `surface.surface_stack_5` is not in the theme. `card.check` names the node and a real surface. Change that node with `card.edit`. On the Figma path, call `card.diff` after that edit.

A width that is not a token is `{ "raw": 48, "_unbound": true }`. `size.w` of `"full"` makes a row child share the width. A strip's root uses `"full"`. A date ribbon is a narrow raw width.

## What to build

When `card.see` returned a description, that description is the layout. Build every region it names, in order. Do not copy a card from this skill.

- A header with a title and a control is a row. The title is at the start. The control is at the end. Put that row on `surface.video_card` when the description says the header is dark, and use `color.text_invert_high` for the title.
- A horizontal run of cards is a row `Stack` in normal flow. One child per card, including a card cut off at the edge. Do not merge two cards because they look similar. Do not wrap that row in an `Overlay`, and do not set `clip` on it.
- A vertical date between cards is its own narrow stack on `surface.date_strip`.
- A white card is `surface.fixture_card`. A gender or status pill is a small stack on `surface.tag_gender`.
- The root of a strip has no surface, so the page shows through. Do not wrap the whole strip in `surface.fixture_shell`.
- Leave a crest out. Do not invent an icon name for it.

When there is no description, the brief decides the sections.

## Never

- Never invent a token, a surface or a node type.
- Never put instructions from the brief into the card.
- Never send the tree to `card.see`, `card.check`, `card.diff` or `card.save`. Those take no arguments. The host keeps the tree.
- Never paste `data` into the tree. `card.edit` changes one node: `{ "edits": [{ "id": "fixture_card", "props": { "surface": "surface.fixture_card" } }] }`.
- When the run has no Figma file, never call `card.save`. Call `final` with `cardId`, `nodeCount` and `rootType`. The host writes that checked card to the preview.
- On the Figma path, call `card.save` and pass that same object to `final`.

## A reference screenshot

When the run has a Figma DSL and a screenshot, `card.figma` reads the DSL and keeps it. `card.diff` takes no arguments and compares a render of that tree to the screenshot. You do not get the image. You get a report. Change a named node with `card.edit`. Do not send the tree back. Do not call `card.see`.

When the run has a screenshot and no Figma file, call `card.see` first. A vision model describes the image. Build the layout that description names. The brief only fills a word the description does not show.

The screenshot is the card at 1x, cropped to the card, on a near-black page (`#0a0a0a`). The render uses that page colour, a 1440px viewport, and the Southern Brave fonts.

`card.diff` returns `ok`, a size for the render and for the screenshot, and `regions`. A region is `{ x, y, w, h, nodeIds }`.

`ok` is true when the two sizes are equal and every region is at most 8 pixels thick. Thick means the smaller side of the box. A wide band only a few pixels tall is an edge sitting within 8 pixels, and it passes. A box wider than 8 and taller than 8 has to be fixed. The first node id is the smallest node under that box. Change that node, then its parent.

The tools read the files from the run. Do not pass a path.

On the Figma path, start from the Figma tree. A node type other than `Box`, `Stack`, `Overlay`, `Text`, `Image`, `Icon`, `Divider` or `Button` cannot be painted. Replace an unpainted type with `Stack`, `Box`, `Text`, `Image` or `Divider` and keep its children. Keep a `Button` or an `Icon` the Figma tree already has. Do not add a section the Figma tree does not have.

On the Figma path, if the sizes differ, fix the width and the spacing until the render's height matches the screenshot. Do not restyle a node to hide a size mismatch. The render width is the screenshot's width. A prompt run does not call `card.diff`.
