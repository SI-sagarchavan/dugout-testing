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
