# 08 · The canvas and Live in a real session

Status: ready-for-human
Type: task
Blocked by: none

## What

Slice 1 was tested in jsdom, in-process and with a static render. Nobody has opened it signed in.

At `http://localhost:5555/#/sb/surface-studio/queue/<sendId>` for the Handoff that run
`bce94e29-59f5-4060-b200-374737ea6598` built (`085cf828-1ff3-47ad-8fee-1fc933a83965`):

- The section draws, scaled, with Southern Brave's theme name and `1368px` in the bar, no notices.
- Fonts are the tenant's (Montserrat, Bakbak One), from the Font Manager links in the frame's `<head>`.
- Studio's own UI is unchanged (no tenant class or `:root` variable leaked).
- Live: the switch is on (the source has `workflowId` `7e960670-5d2d-4654-88f6-31da4d8c7e7b`); turning it
  on runs the hook on :4000 and the cards redraw. If the backend answers `CAST_23`, the hook is not
  published in that Cast.
- A run with nothing published (e.g. failed run `440b7565-…` for Handoff `06958a09-…`) shows "Nothing
  published yet".

## Done when

- Each point above is checked, with a screenshot in the comments, or a ticket for what failed.
