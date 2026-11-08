# 14 · Skeletons for other tenants' sections

Status: in progress
Type: task
Blocked by: 03

## What

What another tenant is shown of a section, with nothing of the club in it.

- `skeletonOf(node)`, pure, from the IR at indexing: fills with the role of their paint (accent or surface, from the token's name or a raw colour's saturation and lightness), outlines, picture placeholders, icons, text as bars by line count; cut to every clipping ancestor. Kept on the row; drawn again each time the section is seen.
- `skeletonSvg(skeleton, palette)`: the SVG in the viewer's colours.

## Done when

- A section's skeleton holds none of its text, and keeps its boxes, roles and clipping.
- The viewer's palette comes from the viewing tenant's own tokens, not flags.

## Comments

2026-11-06: `skeletonOf` and `skeletonSvg` are in (`src/skeleton.ts`, `tests/skeleton.test.ts`); `library search --shared` writes another club's as SVG, in colours given as flags (`--accent`, `--surface`, `--page`, `--ink`, `--on-accent`). Checked against `sb`'s video section: four portrait cards, duration badges in the viewer's accent, play buttons, title and button, no photos. Left: the palette from the viewing tenant's token set (its accent, surface, page and text roles) instead of flags; large vectors on a page of the same role draw nothing (the video section's curved header).

2026-11-07: the palette comes from the viewing tenant's own designs (`src/palette.ts`, `learnPalette` in `src/previews.ts`). For its latest previewed Handoffs, each section's paints are read through the theme its preview used (`theme=` in the link; `background/main/card` is the theme's `background_main_card`) and counted by area: the section's own fill is the page, fills inside are cards or accents by role, text is ink or ink on an accent by the fill under it. Text and overlays on a picture are left out (they are in the photo's colours), and a text colour that would not read on its card is passed over. Proposed as the house fact `library.palette` ("Other clubs' sections in the section library are drawn in: page #ffffff, cards #eeeeee, accent #2939a3, text #…"), which a person approves with `pnpm agent memory review`; the worker proposes one after a tenant's first shared preview, and `pnpm agent library palette --tenant <t> [--propose]` shows it, writes a swatch to `.runs/library/palettes/`, and proposes. `library search --shared` draws in the approved palette, flags over it, neutral until then. `roleOf` now reads `prim` tokens as accents and a token whose name says neither by its colour. `sb` learned page white, cards #eeeeee, accent #2939a3, navy text. Facts are not scoped to an agent, so this one line is in every agent's prompt for that tenant.

Left: large vectors on a page of the same role draw nothing.
