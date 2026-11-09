# 0032. Page choices, and sections with no data

Date: 2026-11-07 · Status: accepted · Amends ADR 0024 (layout detection), ADR 0025 (subagents, pipelines) · Related: ADR 0019, ADR 0026, ADR 0030

## Context

Run `440b7565` built the Southern Brave squad header: "THE BRAVE SQUAD", a WOMEN | MEN toggle, and VIEW MORE. Nothing on it is data. The run still went to `data-bind`, which was told "this run has no data yet, call agent.hookMaker". hook-maker could not reach Cast (no grant for the tenant). data-bind could not publish, and its `final` was refused. section-builder tried the stage three times with the same missing grant and spent $0.36 to end with no preview.

Three things were wrong:

1. **Every section was treated as data.** section-builder ran `bind` after `frame-match` unconditionally, and `bind` had no way to say "nothing here is data".
2. **The toggle was never tabs.** Detection needed three matching items before it looked for tabs, and the selected half (a fill and a stray 1px mark) is not the same shape as the other. Tabs that were detected were "recorded, not lowered": the published frame was two boxes.
3. **A missing sign-in was retried.** A failure that only a person can fix (a grant, a key) was a failure like any other: retried, approved again, failed again.

The toggle's meaning is also not on its own section: it chooses which players the squad strip under it shows. That strip is another Handoff, published by another run.

## Decision

**A page holds choices.** A node with `select: { key, value, initial? }` (`@fanos/dsl`, `page.ts`) is one option of a choice the page holds under `key`. Pressing it sets the key. While the key holds its value it is in its `active` state, otherwise `inactive`, so each option keeps the look the design gave it (`states`). Like a carousel's designed controls (`controlFor`), nothing about it is chrome or a node type.

Any node of any section reads the page's choices in `when`, under `_page`:

- `{ path: "_page.women_men", eq: "men" }`: a panel per tab.
- `{ path: "item.team", eqPath: "_page.women_men" }`: the items of the chosen one. `eqPath` is new: equal to what another path holds.

Values on the page compare loosely (`choiceValue`): a feed's "Women" is the toggle's `women`. A read is never checked against the tree's data (B1), because the key may be another section's. S17 checks the options of one key in one tree: no value twice, one `initial`, more than one option, and a key that is one name.

**Rendering.** The server draws each choice at its start: the option drawn selected, or the host's `page` (`pageDefaults` over every section on the page). So the first paint is the design. `PageChoices`, one per drawn section that writes a choice, makes pressing and arrow keys choose, and sets `data-fos-state` and `aria-selected` on the options of every section in the window. `PageGate` shows a node while its page conditions hold. The server already split them from the data (`splitPageWhen`), so the browser needs only the page state. One store per window: every section drawn in it shares it, as one page does, Studio's iframe included. Both renderers have it: dugout's `@fanos/renderer` and SCRE (`@sikit/scre`, its DSL copied verbatim).

**Tabs are lowered.** Detection reads a segmented toggle: two or more single-label segments touching side by side, one drawn selected. Its parts may differ in shape. With two, the selected one is the one with a background of its own. Two buttons with a gap between them are not tabs. Lowering makes each tab an option of `_page.<key>`. The key comes from the labels (`women_men`), or `config.key` when a person names it. The selected look becomes the `active` state: a surface, a fill, the label's tone. What only the selected tab draws (an underline) is copied to every tab as `synthetic:` nodes, each shown while its tab is chosen. frame-match applies tabs with no question, and keeps them only if the first paint does not move. On the squad header it stays at 94.81%.

**Whether a section shows data is decided before binding.** frame-match reads it (`content.ts`). What repeats is data, except tabs and menus. So is text that reads as a date, a time, a score, a stat, a price, a fixture or placeholder copy, and prose over nine words. Headings, labels and buttons are copy. A photo-sized picture alone is `unsure`, and the layout judge model settles it if it is sure (≥ 0.8). The answer is published with the tree (`content`, in its artifact meta and frame-match's output). section-builder does not run `bind` when it is `none`, and hands over frame-match's preview with `data: "none"`. When frame-match is unsure, `bind` runs and has an honest way out: `bind.static`, then `final` with nothing bound.

**Choices are recorded for sections built later.** frame-match records the choices a section writes when it publishes it (`page_choices`, migration 021, by tenant, project and section). `bind.load` lists the other sections' choices. When the data has a list whose items hold a choice's values in one field, code names it (`links`: `squad.items[].team holds women, men`). The plan then gives that collapse `when: { path: "<as>.team", eqPath: "_page.women_men" }`.

**What needs setup ends the run.** `NeedsSetup` (`@dugout/contracts`) is thrown by a tool that cannot go on until a person sets something up. The MCP hub's missing grant or key (`McpAuthError`) is one, however deep the transport wrapped it. The loop ends the run at once, failed with `needs setup: <what>`. A child that ended so is not tried again, and its parent ends the same way. The person reads what to set up once, not three failures.

## Consequences

- A static section costs one frame-match run. Nothing goes to Cast, and no person approves a hook for copy.
- section-builder's output says `data` (`bound` or `none`), `dataWhy`, and the `choices` the section writes. Planned and data artifact ids are empty when nothing was bound.
- A host that draws a page passes `page: pageDefaults(trees)` to each section's `Render`, so a section that reads another's choice draws at the right start with no flash.
- Not yet: a hook that answers one option at a time (a `gender` input). The strip then holds one option's items and does not follow the toggle; `bind` says so in `remaining`. The general answer is a data source per option, fetched by the host, and needs the page renderer's `surface_section` to fetch live data first.
- A section built before the section whose choice it follows does not see it. Re-run `bind` on it (a follow-up in its thread) once the other is published.
- `grid` is still recorded, not lowered.

## Amendment (2026-11-09): a choice belongs to the slot that draws it

A frame can hold several sections over one background (`.scratch/page-sections/spec.md`): the Team frame is a fixtures strip and a squad with WOMEN | MEN tabs. Each part that shows one kind of data is a **slot**, and the tabs' header is part of the slot whose cards they filter. Scoping every choice to the page was right when the header and the cards were thought of as two sections; with slots it let the squad's tabs filter the fixtures, whose cards carry WOMEN and MEN badges.

- The page still holds every choice (`_page.<key>`); owning a choice is about who may read it, not where it is stored.
- A choice records its **owner**, the slot that draws it. Only that slot's nodes read it, unless a read from elsewhere was asked for on purpose (a designer's note, or a person's answer).
- When a frame has several slots, a choice's key is named for its slot (`the_brave_squad_women_men`), so two slots' tabs never share state. A frame of one slot keeps the key as compiled.
- frame-match's result adds `slots`: each with its tree nodes, whether it shows data, the keys it writes and reads. Whether a slot reads another's key is reported there; refusing it is the binding stage's job.
