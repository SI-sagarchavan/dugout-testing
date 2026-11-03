# @fanos/renderer

Web SDUI renderer and visual-diff harness for FanOS trees. The first package
that produces a pixel — and the acceptance gate for everything downstream:
`generate → render → diff`.

## Scope

Node types: **Box, Stack, Overlay, Text, Image, Icon, Divider, Button,
Repeater, Carousel**. Others draw a diagnostic placeholder.

Every component is a React Server Component, except the carousel's client
root, which is its own entry (`@fanos/renderer/client`, below).

## Stack

Next.js 15 App Router · React 19 · TypeScript strict · vitest · Playwright
(headless) · pixelmatch + pngjs · Node 22.

Depends on `@fanos/dsl` (node types, FlatTree, reify, validate) and
`@fanos/tokens` (CSS emission, registry, `resolveAsset`, motion scale).

```bash
pnpm --filter @fanos/renderer build
pnpm --filter @fanos/renderer test
# headless tests need Chromium once:
npx playwright install chromium
```

## Pure resolvers

| Function | Role |
| --- | --- |
| `resolveNode(props, ctx)` | Universal + Stack props → `{ className, style, dataAttrs }` |
| `resolveAnchor(place)` | 9 anchors × offsets → logical-property CSS |
| `interpolate(template, data)` | `{player.name}` → value; unresolved stays literal |

Token refs always become `var(--fos-…)`. Raw values emit literally and set
`data-fos-raw`. Negative tokens (`-space.6`) become `calc(-1 * var(…))`.
Percentages pass through and are not raw debt.

`size.w: "full"` on a flex child becomes `flex: 1 1 0` (equal thirds for the
stat strip), not `width: 100%`.

## Overlay structure

```
div.fos-overlay          position:relative; overflow:visible (or hidden if clip)
  div.fos-surface-layer  position:absolute; inset:0; z-index:0; overflow:hidden
  …children…             position:absolute per place.anchor; z-index:1; DOM order
```

Surface is a sibling, not a background on the Overlay. Radius + clipping live
on the surface layer; cutouts can bleed past the card top.

## Carousel

A Swiper slider whose first paint is drawn by the server. `Carousel` lays the
slides out in a row exactly as the design does (the gap, the offset before the
first slide, a centred active slide), using CSS custom properties
(`--fos-carousel-gap`, `--fos-carousel-before`, `--fos-carousel-center`). That
is all a screenshot sees, and all a visitor sees before the script loads.

`@fanos/renderer/client` (`src/client.tsx`, built as its own entry so
`"use client"` survives) renders the same markup and, after hydration, loads
Swiper and mounts it on those elements (`src/carousel/mount.ts`). It reads the
custom properties as computed style, so a token resolves to the tenant's
pixels. Once Swiper runs, `data-fos-swiper` turns the first-paint rules off,
and nothing moves.

The carousel draws nothing but its slides, and `styles.css` holds only Swiper's
structural rules and the first paint: no colours, no sizes. Every control is a
node with `controlFor: { target, part }`, drawn with its own look. The browser
side sets `data-fos-state` and the tree's `states` do the rest:

- each slide's node is `active` or `inactive`;
- `prev` / `next` (beside the carousel or on every slide) are `disabled` when
  there is nowhere to go;
- each dot of a `pagination` row is `active` or `inactive`, and a row of one
  dot repeats it per page. A design's row without `states` moves the look of
  the dot drawn differently to the current page;
- a `counter` Text is written from its `format`; a `progress` node is scaled
  along its long side.

`stateRules` (`src/resolve/look.ts`) writes one rule per node and state from the
tree's tokens; a state's surface is a class the token compiler emits.

`tests/carousel.test.ts` runs real Swiper in Chromium on the server's markup. It
checks that the first paint is the design, that nothing moves on mount, that
the arrows, dots, counter and progress follow the carousel, that each state's
look applies, that effects take their options, and that a centred carousel
stays centred.

## Headless harness

```ts
const png = await renderToPng(tree, { data, themeCss, fontCss, width: 534 });
const { score, diffPng, regions } = diff(actual, expected);
const mapped = mapRegionsToNodes(regions, nodeBoxes, tree);
```

`regions` are bounding boxes of connected mismatch clusters. Combined with
`data-fos-id` boxes they are the bridge from pixels back to the tree for the
repair loop.

### CLI

```bash
fos-render png    --tree <f> --data <f> --theme <f> --out <f> [--width 534]
fos-render diff   --tree <f> --data <f> --theme <f> --expected <f> --out <dir>
fos-render report --tree <f> --data <f> --theme <f> --expected <f>
```

## Fonts

Bakbak One (400) and Montserrat (400/500/700) are self-hosted woff2 under
`public/fonts/` and preloaded. The harness waits on `document.fonts.ready`
before screenshotting. A silent fallback would make every text metric wrong.

## Fixture

`../dsl/fixtures/player-card.json` + `fixtures/player-card.data.json`.

Corrections applied in the fixture (not worked around in the renderer):

1. ratio `534/605` (measured card, not `37/50`)
2. stat labels MATCHES / WICKETS / ECONOMY
3. each stat group has `size.w: "full"`
4. placeholder `asset.silhouette.player`
5. footer `space.px: space.9` (~36px; measured strip inset ~37px)
