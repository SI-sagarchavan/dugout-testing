# 04 · Pictures out of the tree

Status: needs-triage
Type: task
Blocked by: 02

## What

`frame-match` publishes each picture as a base64 `data:` URL inside the tree: 5.7 of the "IN THE FRAME"
tree's 5.8 MB (20 Image nodes; the big card's photo alone is 1.5 MB). A page cannot ship that.

Upload each picture once, content-addressed, to wherever 02 decides (the tenant's bucket), and write its
URL into the node (`src`) or the surface set's `assets`. The renderer already takes `https:` URLs and
`asset.*` refs (`resolveAsset`, `prepareSection`'s asset context). Dedupe: the four small-card crops are
identical (246 KB each).

Where: dugout's publish step, which inlines the bytes today (dugout's `packages/renderer/src/page.ts`
says so: "`data:` is accepted with `http(s):` because the default publisher inlines the bytes"). Not yet
traced which code in `agents/frame-match` or `packages/compile` writes them: start there.

## Done when

- A published tree holds no `data:image/` string.
- Studio's canvas and the page draw it the same (pixel check).
