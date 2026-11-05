# Tailwind migration — parked

Status: parked on 2026-11-03. The renderer stays on variable-based CSS (`src/styles.css` plus the
inline `--fos-*` styles from `resolveNode`) until we return to this.

`tailwind-migration.patch` here is the whole migration, against the commit `4ada38b`
(renderer, tokens, Studio preview, web, API measurer, tests, lockfile). Reapply it with:

```bash
git apply .scratch/dynamic-sdui/tailwind-migration.patch
pnpm install && pnpm build
```

The Carousel vocabulary in `@fanos/dsl` and the `swiper` dependency are NOT in the patch; they
stayed in the tree.

## What it did

- Every style became a Tailwind v4 class. `resolveNode` returned `{ className, dataAttrs }`, with
  no inline style. Tokens → theme keys (`space.4` → `p-4`), `Resp<>` → variants
  (`flex-col lg:flex-row`), raw values → arbitrary values (`w-[28px]`).
- `@fanos/tokens` `emitCss` emitted Tailwind source: `:root` vars, `@utility type-*`,
  `@utility surface-*`, and a `@theme` block.
- The CSS was compiled per render with Tailwind's `compile()`: `cssForMarkup(markup, themeCss)`,
  or `cssForElement(<Render/>, themeCss)` in a Server Component. About 6 ms warm, 7.5 KB gzip for a
  Studio section.
- Text markers became data attributes (`data-fos-clamp`, `data-fos-fixed-h`).

## Verified

`pnpm eval measure` was identical to `agents/frame-match/evals/baseline.json` on all 18 frames.
Renderer 248, tokens 180 and Studio 17 tests passed, and `apps/web` built with `next build`.

## Learned

- **Composite utilities must have zero specificity.** Tailwind orders utilities by the
  properties they set, not by intent. A Divider's `border-0` lost to its surface's
  `border: 1px solid`, so a 1px rule rendered 2px wide and moved 9 of the 18 frames. Emitting
  `type-*` and `surface-*` as `:where(&) { … }` fixed it.
- No default theme and no preflight: add `--spacing-0: 0px` or `inset-0`, `m-0` and `min-w-0`
  produce nothing.
- Next.js refuses `react-dom/server` in Server Components, so classes have to be collected by
  walking the element tree. A client component's classes must arrive as props.

## When we come back: deliver it the way southernbrave.com does, generate it our way

The live site ships a static per-theme sheet (`/static-assets/css/<ver>/<themeId>.css`, every
token pregenerated as a class), a build-time Tailwind sheet, hand-written CSS for each widget, and
558 inline `style` attributes for per-instance values that a prebuilt sheet cannot hold.

The plan was a hybrid:

1. A static theme sheet per tenant and theme version (vars, `type-*`, `surface-*`, every token
   utility × breakpoint), cached by the CDN.
2. A small sheet per section for the arbitrary values only, compiled at **publish** time and
   stored with the surface version. A published tree is fixed, and bindings never add classes.
3. Per-render compile only in Studio and the harness.
