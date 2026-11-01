# 19. Matching a Figma frame starts from the plugin's Send

The `card` agent reads a DSL file and a screenshot, and most of what decides fidelity never reaches it: the IR, the surfaces, the export's theme. `card-match` starts from what the plugin's Send already stored, by export id.

- **Trigger.** `pnpm card:watch` is a host (ADR 0009) that looks at the control plane for new exports and queues a run per frame, so the plugin and the pipeline do not change. The plugin can't show the run's link, because the control plane doesn't know about it. A Send made while the watcher is down still runs when it next starts, once the tenant has a prior `card-match` run.
- **The compiler stays the source.** The model never writes a tree. It adds overrides keyed by Figma id, and each is an input to a recompile, so they survive one.
- **Code does what needs no judgement.** Tokenless gradients come from the IR's matrix. Placeholder icons are cropped from the screenshot, with any gradient above them taken back out of the pixels. Only then does the model look.
- **Measured, not claimed.** Each override is rendered and compared. It is undone if the pixel match drops, conform errors rise, or nothing improves. The approval and `final` carry code's numbers, and `final` is refused if they differ. Publishing is refused until the worst findings have been examined, because models stop early when the first number looks high.
- **Both signals are needed.** Conform is blind to paint and pixels can't say why, so findings give both, by node and by shared surface.

## Placing a screenshot

Figma exports a layer as it shows and doesn't say where it starts. Three cases, in order:

1. **Exact.** The screenshot is the layer's _visible_ box (its box cut by the frame and every ancestor that clips), at a whole device scale, to within a pixel. A photo wider than its card comes out as the card's size, so this is the box to compare against, not the layer's own.
2. **Estimated.** A few pixels larger than the layer on one side or both (a shadow, or text overflowing its box). It is slid over the render and kept where they differ least, and accepted only if that is at least half a match. It is flagged `estimated`, and art can be cropped from it at the place the search found.
3. **None.** Anything else is not compared, and the plate's reason is reported.

What a screenshot draws past the frame has no render to meet, so only the part inside the frame is compared.

A screenshot of a layer holds that layer alone, so it is compared with a render of that layer alone: CSS hides everything else without moving it, and both sit on the same grey. Comparing with the whole render counted every layer above as a difference.

## Art groups

The IR has no masks, so a group drawn with them compiles to its raw rectangles stacked up. When the export holds a picture of such a group (a `GROUP` with vector art and at most two text layers), the group becomes that one picture. Anything it contains is baked in, which the report says. A group with more text is content, and stays real.

## Coverage

A match is over the screenshots that could be placed, which can be a sliver of the frame. A video card with a 120×120 icon and a 44×20 label placed showed 45.69% over 4.31% of its area. Every result now carries `coverage`, the share of the frame those screenshots cover, and below a quarter of it the frame is published as unmeasured. It also carries `unchecked`, the layers on show that no compared screenshot holds: a screenshot covering an area says nothing about a layer above it that it doesn't contain.

## Evals

`pnpm card-match:measure` runs the code alone on the three eval frames and prints them next to `evals/baseline.json`, recorded before these changes. `pnpm eval card-match` runs the agent on the same frames and grades it against that baseline: it must cover at least as much, and match at least as well. `pnpm card-match:measure --write` records a new baseline.

## What the export now says (IR 1.9.0)

The plugin used to screenshot only the root's direct children, and the IR said nothing about alignment, masks, crops or where a layer's pixels are. The agent inferred each from a picture, and each inference was a way to be wrong. IR 1.9.0 adds them, all optional, absent meaning the default: `geometry.renderBbox` (where a layer's pixels are), `text.textAlignHorizontal` / `textAlignVertical`, `isMask` / `maskType`, and `image.transform` (the crop window) with rotation, tile scale and paint opacity. The compiler turns alignment into `Text.align`. An export from before 1.9.0 parses and scores as it did.

The plugin also exports a picture of each layer that is art (`src/art-plates.ts`): the frame itself, a layer that contains a mask (its export is the masked result), an image with no text, and the largest subtree of nothing but paths. Plate names that start with `art-` are what crops are cut from; they are not measured. When the export holds the frame's own picture, that is the one the match is measured against, so the root's fill is compared for the first time. The control plane takes up to 200 pictures, and the plugin stops at an 18 MB budget.

Nothing here has been run against a Figma export yet. It is tested against the selection on real IRs and against stubbed Figma nodes. The first Send from a rebuilt plugin is the real test, and `pnpm card-match:measure` against it is how to read it.

## Looking

The score counts pixels, and some defects barely move it: text on the wrong edge moves it by a third of a point, and a background no screenshot holds not at all. `frame.look` builds the design (its pictures laid on grey) beside the rebuild, cuts the frame into tiles each shown at a size where text is readable, and asks a vision model for the differences a person would notice. Each comes back with a place in the frame and the layers under it, so it can be read with `frame.node` and fixed with `frame.override`. The image never enters the transcript (`describeImage`).

An override may now create a surface under a name the compiler never used, which is how a dropped background gets painted. `frame.load` lists layers whose IR has a fill and whose compiled node paints none, as `unpainted`, with the theme token the style's name points at.

`pnpm card-match:vision` measures it: it breaks a first-passed frame in a known way (a picture taken out or shrunk, words changed, a text colour changed, a background removed), then asks whether the score noticed and whether a difference was reported at that place that the clean frame did not report there. It also looks at two identical pictures, to count what is invented. `CARD_MATCH_VISION=off pnpm eval card-match` runs the same cases with `frame.look` answering "not available", to compare the whole agent.

## When looking fails

`frame.publish` is held until `frame.look` has been called once, in every run, because a model that is only told to look does not (an A/B with it optional had 0 looks). A step the run cannot do must not be one it cannot finish without, so after two failures of `frame.look` itself (the vision model down, a lapsed credential, a render error) the hold lifts and the error tells the model to say so in `remaining`. A region outside the frame is the caller's mistake and does not count. A region is cut to the frame before anything is shown or placed, so a finding's `where` is the place it was seen. `frame.load` has ten minutes, not five: a big frame measures, fixes, checks each fix and measures again, and under three runs at once that passed five.

Whether to look first or last was measured, 3 attempts per frame on 6 frames. Looking first gained +2.01 points over the code alone and passed 18 of 18; looking last +1.47 and 16 of 18; never looking +0.67 and 15 of 18. The one frame that carries the difference is match-centre.

## Limits

- A crop is a stand-in: right pixels, but not an icon or data. Real art needs vectors from the export, or the design system's icon registry.
- A screenshot more than 16 pixels bigger than its layer is not compared or cropped from. An export with no screenshot that fits is still compiled and published, but marked unmeasured: no before or match, the reason in `unmeasuredBecause`, overrides refused because nothing can check them, and the approval and `FINISHED` block say UNMEASURED. Having the plugin send each screenshot's origin would remove the search, and exporting bitmap fills as assets would replace the crops of photos.
- The screenshot's page colour is unknown, so the render is on mid grey, and a screenshot is laid over the render rather than over a colour.
- The agent's stored themes are the newest `token_set`, and Studio's preview falls back to the newest one. They are the project's theme plus a frame's raw paints. The agent itself skips them when it picks a theme.
- Overrides live in `.runs/card-match/<runId>.json`, on the worker's disk. A run resumed on another machine would have to start over: to move before production (H7).
- Compiler bugs found here are reported in `compilerFindings`, not fixed: the agent doesn't edit the pipeline.
- A vision model invents differences. On identical pictures it reported about one per tile, one in three of them medium or high. Treat `frame.look` as a list of leads to read with `frame.node`, never as a verdict. Content on a tile boundary is seen in halves.
