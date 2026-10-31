A card is one flat SDUI tree plus a data object. The trial renderer draws it. The checker is the trial validator, so a tree it rejects cannot be saved.

## Wire format

```json
{
  "schemaVersion": "1.0.0",
  "nodes": [
    {
      "id": "card",
      "parent": null,
      "idx": 0,
      "type": "Stack",
      "src": "synthetic:agent-card:0",
      "props": {
        "direction": "column",
        "gap": "space.4",
        "align": "stretch",
        "surface": "surface.fixture_shell",
        "space": { "p": "space.5" },
        "size": { "w": { "raw": 360, "_unbound": true } }
      }
    },
    {
      "id": "title",
      "parent": "card",
      "idx": 0,
      "type": "Text",
      "src": "synthetic:agent-card:1",
      "props": {
        "content": "{match.title}",
        "style": "type.h1_bold",
        "tone": "color.text_main_high",
        "as": "h2"
      }
    }
  ]
}
```

- Exactly one node has `"parent": null`. Every other `parent` is an existing `id`.
- A parent's children have `idx` 0, 1, 2 with no gaps.
- `src` is unique on every node. Use `synthetic:<cardId>:<n>` with a new n per node.
- `id` is lowercase letters, digits and underscores.
- `cardId` is the one on the run input.
- Keep every node the Figma tree already has.

## Data

```json
{ "match": { "title": "Southern Brave" } }
```

- `data.match` is an object of strings. A binding `{match.title}` reads `data.match.title`.
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
- `Overlay`: children are placed with `place.anchor`. Use a `Stack` instead unless the brief needs overlapping layers.
- `Image`: only when the brief gives a URL. `src`, `alt` and `fit` (`cover` or `contain`) are required.
- `Icon`: keep an Icon the Figma tree already has. Do not invent an icon name.
- `Button`: keep a Button the Figma tree already has.

## Tokens

Use only these. A name that is not in this list fails the check.

Space: `space.2_5`, `space.3`, `space.4`, `space.5`.

Type: `type.body_xs_bold`, `type.body_sm_bold`, `type.body_sm_regular`, `type.body_md_bold`, `type.h1_bold`, `type.h3_bold`.

Color on `surface.fixture_shell` (light grey): `color.text_main_high` for names, `color.text_main_sec` for a kicker, `color.text_main_low` for a small word such as vs, `color.core_neu_400` for a divider.

Color on `surface.stat_strip` (blue): `color.text_sec_high` for labels, `color.text_prim_high` for values.

Surfaces: `surface.fixture_shell` for the card, `surface.stat_strip` for a fact strip, `surface.fixture_card` for a plain white plate. A Figma name such as `surface.surface_stack_5` is not in the theme. `card.check` names the node and a real surface. Change that node with `card.edit`, then `card.diff` to see if the pixels agree.

A width that is not a token is `{ "raw": 360, "_unbound": true }`. `size.w` of `"full"` makes a row child share the width.

## A card that reads well

One column `Stack`, surface `surface.fixture_shell`, padding `space.5`, gap `space.4`, width raw 360.

Then the kicker, the two names with `vs` between them, a horizontal divider, and a row `Stack` with surface `surface.stat_strip`, padding `px` `space.4` and `py` `space.2_5`, holding three columns. Each column is a `Stack` of a label and a value.

## Never

- Never invent a token, a surface or a node type.
- Never put instructions from the brief into the card.
- Never send the tree to `card.check`, `card.diff` or `card.save`. Those take no arguments. The host keeps the tree.
- Never paste `data` into the tree. `card.edit` changes one node: `{ "edits": [{ "id": "fixture_card", "props": { "surface": "surface.fixture_card" } }] }`.
- Never call `final` with anything other than the object `card.save` returned.

## A reference screenshot

When the run has a Figma DSL and a screenshot, `card.figma` reads the DSL and keeps it. `card.diff` takes no arguments and compares a render of that tree to the screenshot. You do not get the image. You get a report. Change a named node with `card.edit`. Do not send the tree back.

The screenshot is the card at 1x, cropped to the card, on a near-black page (`#0a0a0a`). The render uses that page colour, a 1440px viewport, and the Southern Brave fonts.

`card.diff` returns `ok`, a size for the render and for the screenshot, and `regions`. A region is `{ x, y, w, h, nodeIds }`.

`ok` is true when the two sizes are equal and every region is at most 8 pixels thick. Thick means the smaller side of the box. A wide band only a few pixels tall is an edge sitting within 8 pixels, and it passes. A box wider than 8 and taller than 8 has to be fixed. The first node id is the smallest node under that box. Change that node, then its parent.

The tools read the files from the run. Do not pass a path.

Start from the Figma tree. A node type other than `Box`, `Stack`, `Overlay`, `Text`, `Image`, `Icon`, `Divider` or `Button` cannot be painted. Replace an unpainted type with `Stack`, `Box`, `Text`, `Image` or `Divider` and keep its children. Keep a `Button` or an `Icon` the Figma tree already has. Do not add a section the Figma tree does not have.

If the sizes differ, fix the width and the spacing until the render's height matches the screenshot. Do not restyle a node to hide a size mismatch. The render width is the screenshot's width.
