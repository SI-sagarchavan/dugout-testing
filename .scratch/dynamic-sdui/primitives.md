# Primitives: what `@fanos/dsl` and the renderer need, measured against the Widget Builder

Status: assessment, 2026-11-02. Compared against `fanxp-web-renderer` `feature/widget-builder` (67ee3a48, `packages/widgets`, runtime 0.6.0) and `wnm-fanxp-frontend` `feat/widget-builder` (61b362de, the builder UI and Assistant). Follows `spec.md` in this folder.

## Decided (2026-11-02)

These replace the matching recommendations below wherever they differ:

- **Primitives are built on Radix** (Tabs, Select, DropdownMenu or NavigationMenu, Accordion, Dialog, Popover, Tooltip, ToggleGroup, Checkbox, Switch, RadioGroup, Slider, ScrollArea, Progress, Toast …) and styled with our tokens.
- **The carousel is Swiper**, with its configuration exposed through the DSL (effects, breakpoints, pagination types, free mode, grid, autoplay options, a11y, thumbs …). This replaces the scroll-snap design in §5.
- **Binding stays ours**: `{path | pipe:arg}`, closed and simple. The widget's `{{ }}` is not adopted.
- **State is XState**: the workflow (statuses, transitions, triggers, actions) is generated as an XState machine from the DSL.
- **Server state is TanStack Query**: Cast sources, polling, server prefetch and hydration to the client.
- **No separate client runtime or island layer.** Interactive primitives are Next.js client components inside the server-rendered tree. Extracting the widget's engine (§2 point 5, §6 point 4) is dropped; we take its _vocabulary and semantics_, not its code.

See `from-widget-builder.md` for what else the Widget Builder has that we haven't planned.

## The finding in one paragraph

The two systems are halves of the same thing. **`@sikit/widgets`** has the behaviour layer: 76 primitives, a state store, JSONata `computed`, Cast data sources with input mapping, a workflow engine (triggers, guards, actions, polling every 5 s or more, paused off-screen), UI events (`on`), two-way `bind`, `motion`, per-breakpoint props and `hideOn`. It is weak on layout fidelity: raw CSS widths, no anchored overlay, no blend modes, and a `className` + free-CSS escape hatch. Its own page check against southernbrave.com lists exactly those gaps: gradient fades over images, carousel bleed, rotated text, translucent panels, clickable tiles. **`@fanos/dsl`** has the fidelity layer: tokens only, Figma-anchored `src`, Overlay with anchors, blend, crops, responsive values on every layout prop, a flat wire format and conformance. It has almost no behaviour, and its renderer cannot run anything in the browser. **Recommendation: keep our layout vocabulary and adopt the widget runtime's behaviour model and interactive primitives, with the same names and semantics, so a Figma-built section and a Builder widget end up as one DSL.**

## 1 · Where each side stands

|                  | `@fanos/dsl` + `@fanos/renderer`                                                                                                        | `@sikit/widgets`                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitives       | 18 in the vocabulary, **9 rendered** (Box, Stack, Overlay, Text, Image, Icon, Divider, Button, Repeater). The others draw a placeholder | 76, all rendered, each with meta, examples and a contract test                                                                                                                                                  |
| Layout precision | high: tokens, `place.anchor`/`offset`, `span`, `blend`, `column`, `size` with fill/hug, responsive `md`/`lg` on each prop               | medium: flex props, raw CSS lengths, `responsive: { tablet, desktop }` prop overrides, `className` + `definition.css`                                                                                           |
| Styling          | token-strict: surfaces bundle layers, borders, radius and shadow; `deviations` record exceptions                                        | theme tokens plus raw lengths, per-edge borders, `backgroundOverlay`, free CSS in the Shadow DOM                                                                                                                |
| State            | none. `Tabs.bind` writes a key that nothing reads                                                                                       | `state`, `computed` (JSONata), `status`                                                                                                                                                                         |
| Events           | `Button.action` (`navigate`, `open`, `submit`, `custom`)                                                                                | `on: { click, change, submit, input, select }` → a workflow event; `bind`                                                                                                                                       |
| Data             | the tree binds paths. The source lives in Studio's manifest. No fetching                                                                | `data.<source>` = a Cast hook + `inputMapping` (JSONata over props and state) + `sample`; `fetch` action; `initialData` from the server                                                                         |
| Live updates     | none                                                                                                                                    | `interval` trigger (≥ 5 s, paused off-screen and in hidden tabs) + `fetch { silent }`                                                                                                                           |
| Motion           | `reveal` adds a class with no CSS behind it                                                                                             | `motion { enter, duration, easing, delay, stagger, press }`, theme motion tokens, reduced motion respected, `Transition`                                                                                        |
| Responsive       | per prop: `{ base, md, lg }`                                                                                                            | per node: `responsive` overrides, `hideOn`, `show`, measured on the container                                                                                                                                   |
| Runtime          | React Server Components, no client                                                                                                      | Preact client runtime in a Shadow DOM; server prefetch of first Cast calls (`initialFetches`, `widget-prefetch.ts`)                                                                                             |
| Carousel         | rich schema (`peek`, `snap`, responsive `slidesPerView`, `controlsPlacement`), not rendered                                             | rendered: `effect` slide/fade/cards/coverflow, pagination, arrows, loop, autoplay, controlled `index`, `change`. **No swipe** (translate only, no pointer or scroll-snap handling), no pause on hover, no bleed |
| Self-description | `emit/json-schema.ts`, `emit/docs.ts`                                                                                                   | `describe()`, a manifest, generated docs, `llms.txt`, `PROP_DOCS`                                                                                                                                               |

The production page renderer on the same branch already places a widget on a page as a template (`content_type: "widget"`, `PageWidget { definition, render: "server" | "client", props }`) and prefetches its Cast data on the server. Pages are already a list of templates, and a widget is one kind of template. That is the slot a Figma-built section fits into.

## 2 · Recommended direction

1. **One behaviour model, the widget's.** `state`, `computed`, `data` (Cast binding), `workflow` (statuses, transitions, triggers, actions), `props`, `analytics` on the tree envelope; `on`, `bind`, `visibleIn`, `motion`, `hideOn` on nodes. Copy the field names and semantics so the two validators, the builder UI and the Assistant all read one vocabulary. This **replaces** the `refresh` block proposed in `spec.md` §4: polling is an `interval` transition with a silent `fetch` and a `condition` (for example, the match is live). That already exists and is tested.
2. **Our layout vocabulary stays.** Box, Stack, Grid, Overlay, Section and Repeater, with tokens and anchors, are what Figma fidelity needs, and the widget page check shows what is missing without them.
3. **Interactive primitives are added to our vocabulary, with the widget's prop names wherever the concept matches**, adjusted to our rules: tokens instead of raw values, responsive values, controls as chrome.
4. **Domain widgets are embedded, not re-implemented.** A new `Widget` node places a Builder widget (by id and version) inside a Figma-built page, for polls, predictors, a match centre or fantasy. The 15 showcase widgets and the 76 primitives come with it, and nothing is duplicated.
5. **The renderer is server first with client islands.** Static structure renders on the server, as today. Nodes that need the browser hydrate as islands that share one page runtime. The widget's `store`, `workflow/engine`, `state/jsonata` and `data/cast-client` import no Preact and no DOM, so the runtime can reuse them. Only `ui/` is Preact.

## 3 · Envelope additions (`FlatTree`)

```ts
interface FlatTree {
  schemaVersion: string;
  nodes: FlatNode[];
  // new; same shapes as WidgetDefinition
  props?: EmbedProp[]; // page and placement params: teamId, seriesId …
  state?: Record<string, unknown>; // initial values: tab, filter, slide, form …
  computed?: Record<string, Jsonata>; // derived, pure, in declaration order
  data?: Record<string, CastBinding>; // { hookId, hookUuid, inputMapping, sample, sampledAt }
  workflow?: { initial: string; statuses: Status[]; transitions: Transition[] };
  analytics?: AnalyticsConfig;
}
```

- Binding scopes inside nodes become `data.*`, `state.*`, `computed.*`, `props.*`, `status` and `sources.<name>.loading/error/updatedAt`, plus the Repeater's `as`. Today our refs only read whatever the host passed in.
- `fromCastFlow` stays: it is how a Cast response is normalised into `items` for both systems.
- **Binding syntax is a decision.** Ours is `{path | pipe:arg}` with a closed pipe list. The widget's is `{{ path | filter }}` with a larger filter list (`relative`, …). Recommendation: accept `{{ }}` and map our pipes to their filter names, and keep the rule that pipes and filters are a **closed list** every renderer implements.
- **JSONata stays out of node props.** It runs only in `computed`, `inputMapping`, conditions and actions, as in the widget. Nodes bind to `computed.x`.

## 4 · Node-level additions (universal props)

| Prop                     | Shape                                                                                                                            | Why                                                                                                                                           | From                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `on`                     | `{ click?, change?, submit?, input?, select? }` → event name                                                                     | every interaction goes through the workflow                                                                                                   | widgets                        |
| `bind`                   | state path                                                                                                                       | two-way for Tabs, Select, inputs, Carousel index                                                                                              | widgets                        |
| `visibleIn`              | status[]                                                                                                                         | loading, ready, error and empty views without `when` chains                                                                                   | widgets                        |
| `when`                   | **extend**: may read `state.*`, `computed.*`, `status`                                                                           | tab panels, filters                                                                                                                           | ours, extended                 |
| `hideOn`                 | `("base" \| "md" \| "lg")[]`                                                                                                     | a column hidden on phones. Today only `platform` exists                                                                                       | widgets (our breakpoint names) |
| `motion`                 | `{ enter, duration, easing, delay, stagger, press, hover }` with theme tokens                                                    | replaces `reveal` (kept as an alias that maps `fade-up` → `enter: slide-up`). `hover` is new: card lift and image zoom are on every club site | widgets + `hover`              |
| `action` (on containers) | the existing `action` union                                                                                                      | **the whole card is a link**. Their page check lists "click on a tile" as a gap, and today we can only put an action on a Button              | new                            |
| `pin`                    | `{ mode: sticky \| fixed, edge: top \| bottom, offset, scope: page \| section, onScroll: none \| hide-down-show-up \| compact }` | sticky headers and subnavs, floating CTAs; neither system has it (the widget only has a sticky table header)                                  | new (`spec.md` §5)             |
| `slot`                   | `trigger \| panel \| header \| footer \| media \| empty \| loading`                                                              | a child declares its role in an Accordion, Menu, Dialog or Carousel; checked against the parent type, like `place.anchor`                     | new                            |
| `variants`               | `{ hover?, active?, selected?, compact? }` → a partial prop override                                                             | the selected tab, the active slide, a compact header after scrolling, hover states from Figma interactive components                          | new                            |

`className` and free CSS are **not** adopted. Our path for "props cannot say it" stays a `deviations` entry plus a `vocabularyGap` report, so the vocabulary grows instead of leaking.

## 5 · Primitives

Legend: **keep** = exists, render it as it is · **extend** = exists, needs props · **add** = new.

### Layout

| Primitive           | Status          | What to do                                                                                                                                                               |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Box, Stack, Overlay | keep            | already rendered                                                                                                                                                         |
| Grid                | keep → render   | the vocabulary is complete; add `autoFlow: row \| dense` only if a design needs it                                                                                       |
| Section             | extend → render | add `pin`; `backdrop` already exists. Sections carry `data`/`workflow` scope boundaries for islands                                                                      |
| Repeater            | extend → render | adopt `key` (stable identity for animation and polling diffs), `stagger`, and an `empty` slot child. Implement `paginate` (`more`, `pages`) as `fetch` with a page param |
| **ScrollRow**       | add             | a horizontal scroll strip with snap and no paging (the widget's `ScrollArea`). Different from a Carousel: no controls, free scroll. Many Figma "rails" are this          |
| Carousel            | extend → render | see below                                                                                                                                                                |
| Custom              | keep            | stays for opaque renderers                                                                                                                                               |
| **Widget**          | add             | `{ id, version, props, render: server \| client }`, placing a Builder widget in the page                                                                                 |

**Carousel**, the merged schema (ours + the widget's + both systems' gaps):

```ts
Carousel {
  slidesPerView: Resp<number | "auto">     // ours; fractions peek
  slidesPerGroup?: Resp<number>            // new: how many a step moves
  gap?: Resp<Val>; peek?: Resp<Val>        // ours
  align?: "start" | "center"               // new: centred slides
  snap: "start" | "center" | "none"        // ours; "none" = free scroll
  effect?: "slide" | "fade" | "cards" | "coverflow"   // widget
  loop: boolean                            // both
  autoplay: Val<"duration"> | false        // ours (token); minimum 800 ms as in widget
  pauseOnHover?: boolean                   // new, default true (WCAG 2.2.2)
  bleed?: Resp<"none" | "end" | "both">    // new: slides run off the page edge (widget gap list)
  overflow?: "clip" | "visible"            // new: cut-outs that stand above the cards (widget gap list)
  controls: Resp<("arrows" | "dots" | "progress" | "counter")[]>   // ours, now responsive
  controlsPlacement: "edge" | "overlay" | "below-start" | "below-center" | "below-end"
  controlsStyle?: { arrow?: surface token; dot?: color token; dotActive?: color token }  // new, still chrome (S10)
  bind?: state path                        // controlled index (widget `index`)
  on?: { change }                          // widget
}
```

The renderer builds it on CSS scroll-snap, which gives native touch swipe, momentum scrolling and keyboard scrolling with no JS, and server-renders slide 1. Arrows, dots, autoplay, loop and `effect` other than `slide` hydrate as an island. The widget's translate-only track has no swipe; this design has it by default.

### Navigation and disclosure

| Primitive             | Status        | What to do                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs                  | extend        | `options` per item gain `icon` and `count`; `variant` gains `chips` (this also covers the widget's `FilterChips` and `ToggleGroup`, one node in the spirit of `Tag`); add `multiple` (chips only), `scroll`, `block`, `align`; `bind` + `on.change`. Panels stay elsewhere and use `when: { path: "state.tab", eq }` |
| **Select** (dropdown) | add           | `options` (literal or binding), `bind`, `placeholder`, `label`, `variant: field \| inline \| pill`, `size`, `on.change`. A native `<select>` on mobile and a listbox on desktop. Season and competition pickers, "sort by"                                                                                           |
| **Menu**              | add           | a structural dropdown for navigation and overflow menus: children `slot: trigger` + `slot: panel`; `openOn: click \| hover`, `placement`, `bind` (open state). Header nav mega menus                                                                                                                                 |
| **Accordion**         | add           | structural: one item with `slot: trigger` (or a `title`) + panel; `defaultOpen`, `bind`, `group` (only one open at a time across siblings). FAQ, squad by position, ticket info                                                                                                                                      |
| **Dialog**            | add           | `mode: modal \| drawer`, `side` (drawer), `bind` (open), `dismissible`. Covers the widget's Dialog and Drawer as one node: mobile nav, video lightbox, filters on mobile                                                                                                                                             |
| **Pagination**        | add           | `bind` page, `pages` binding, `variant: numbers \| compact \| more` (`more` is a "Load more" button that fetches the next page and appends)                                                                                                                                                                          |
| Link                  | keep → render | add `on.click` for tracking                                                                                                                                                                                                                                                                                          |

### Content and media

| Primitive     | Status          | What to do                                                                                                                                                                    |
| ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text          | keep            | `orientation` already covers rotated text (a gap in the widget list)                                                                                                          |
| RichText      | keep → render   | `prose` style                                                                                                                                                                 |
| Image         | extend          | add `lightbox` (opens a Dialog), `loading: lazy \| eager` (we have `priority`)                                                                                                |
| Icon, Divider | keep            |                                                                                                                                                                               |
| Tag           | keep → render   | `LiveIndicator` = Tag + `motion: { enter: "pulse" }` (a new preset)                                                                                                           |
| Button        | extend          | `selected` (bound), `on`. `variant`/`styleN` stay token-bound (the widget's "custom button colours" gap is a surface token here)                                              |
| **Video**     | add             | `src` (mp4 or HLS), `poster`, `autoplay` (muted only), `loop`, `controls`, `on.change` for play, pause and progress (analytics). A P1 gap in both systems                     |
| **Embed**     | add             | YouTube, X, Instagram or a ticketing iframe from an allow-list of providers by `provider` + `id`, never a free URL; `ratio`. Needs a policy decision, as the widget docs note |
| **AdSlot**    | add             | the widget's AdSlot: `slotId`, `size`, viewability event. Sponsors and ads are on every club page                                                                             |
| Countdown     | extend → render | ticks on the client; `on.change` at zero so the workflow can switch status ("sales open"). Fills the widget's missing "at time X" trigger                                     |

### Data display

| Primitive    | Status | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Table**    | add    | standings are on every sports site and we have nothing that draws one correctly. Structural: `Table { columns: [{ key, width, align, sticky, hideOn }], stickyHeader, scroll: x, striped, dense }` > `TableRow { header?, highlight? }` (inside a Repeater) > `TableCell { span }`. Structural rather than a `DataTable` with column JSON, so a Figma-drawn table compiles cell by cell and conformance still works. Sorting is `on.click` on a header cell → `set state.sort` → `computed` sorts |
| **Progress** | add    | a bar or ring with a bound `value`/`max`: possession, poll results, budget. Hard to compose from boxes because the width is data                                                                                                                                                                                                                                                                                                                                                                  |
| Chart        | defer  | embed through `Widget` for now (LineChart, Chart, StatCompare live there)                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Input and forms

| Primitive                                               | Status | What to do                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Input**, **Checkbox**, **Switch**, **Form**           | add    | newsletter sign-up, contact forms and fan preferences. Same props as the widget (`bind`, `label`, `placeholder`, `error`, `required`), plus `Input` with an `action` slot (a button inside the field, a gap in the widget list) and `Checkbox` with a RichText label (a link in the consent text, also a gap). Submitting goes through the workflow (`validate`, then `sdk.call` or a Cast write hook) |
| Everything else (Slider, DatePicker, OTP, Chat, Rating) | defer  | through `Widget`                                                                                                                                                                                                                                                                                                                                                                                       |

### Feedback and states

| Primitive                      | Status        | What to do                                                                                                                                                                                                                 |
| ------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skeleton**                   | add           | `lines`, or `shape: box \| text \| circle` with size. The renderer can also **derive** a skeleton from a Repeater template (the same boxes, filled with a shimmer), so most data sections need no hand-built loading state |
| **Empty / error**              | through slots | `Repeater`'s `slot: empty` child, and Section `visibleIn: ["error"]` children. No new node type                                                                                                                            |
| Spinner, Alert, Tooltip, Toast | defer         | Toast is on the widget's P1 list; add when a page needs it                                                                                                                                                                 |

**Totals:** 18 → 32 node types: add ScrollRow, Widget, Select, Menu, Accordion, Dialog, Pagination, Video, Embed, AdSlot, Table, TableRow, TableCell, Progress, Input, Checkbox, Switch, Form, Skeleton (19), and fold Tabs/Chips/ToggleGroup into one. Fewer than the widget's 76 on purpose: sports-specific and chart primitives come through `Widget`, and the Figma design composes the rest from layout primitives.

## 6 · The rendering engine

**Today:** `Render.tsx` is a server-only switch over 9 types, and anything else is a placeholder.

**Target:**

1. **One registry, like `definePrimitive`.** Each node type has its meta (doc, props, events, slots, examples), a server component and, only if it needs one, a client island. The JSON Schema, the docs, the agent prompt and the validator are generated from the registry, as `meta:emit` does for the widget. A contract test per primitive checks that it renders every prop, has no raw values, has `src` on its root, merges `testId`, and that its island hydrates without changing the server markup.
2. **Server first.** Every node renders on the server with its initial state and initial data, so the first paint is complete and correct for SEO and for the pixel harness. The page renderer's `widget-prefetch.ts` already shows the pattern: run the first `fetch` actions on the server and pass `initialData` to the client.
3. **Islands only where needed.** A subtree becomes an island when it contains Carousel (beyond pure scroll-snap), Tabs, Select, Menu, Accordion, Dialog, Countdown, Video, Form inputs, or any node with `on`, `bind`, `motion.enter`, `pin.onScroll`, or a `when`/`visibleIn` that reads state or status, or when its Section has an `interval` transition. Everything else ships no JS.
4. **One page runtime.** Every island on the page shares one store and one workflow engine (`PageRuntime`), so a Tabs in one section can filter data in another and one poller serves every reader of a source. Reuse `@sikit/widgets` `state/store`, `state/jsonata`, `state/computed`, `workflow/engine` and `data/cast-client`. They are framework-agnostic. Extract them into a shared package (for example `@sikit/widget-core`) instead of copying them, so the two runtimes cannot drift.
5. **Behaviour in CSS where possible.** `pin: sticky` is `position: sticky`, `motion.enter` uses `animation-timeline: view()` with an IntersectionObserver fallback, `hover` uses transitions, and `hideOn` uses media or container queries. JS is for state, data and timers.
6. **Responsive by container, too.** The widget measures its container (a widget can sit in a sidebar). Page sections are mostly full width, so viewport media queries are fine for `Resp<>`. A section placed in a narrow column, or a `Widget` node, needs container queries. Support both: `Resp<>` on viewport by default, container queries inside a `Widget` and in a `Grid` cell flagged `container: true`.
7. **Accessibility is built in, not configured.** Carousel: roving focus, `aria-roledescription="carousel"`, live-region announcements, autoplay paused on hover, on focus and with reduced motion. Tabs: arrow keys, `role="tablist"`. Menu and Select: listbox keyboard behaviour. Dialog: focus trap and return.
8. **A test harness for behaviour.** The pixel harness renders the static server output (state and data as declared, motion off). A new Playwright scenario runner drives islands: swipe, click an arrow, pick a tab, advance the clock past an interval, scroll past a pin. Scenarios are generated from the node meta, so each primitive is covered without hand-written tests.

## 7 · What the compiler and the agent get from this

- The compiler can emit `Section`, `Grid`, `Carousel`, `ScrollRow`, `Table` and `Repeater` from IR signals (`spec.md` §1), because the renderer can now draw them.
- The intent step (`spec.md` §2) has real targets. "Dropdown to pick the season" → `Select` + `state.season` + `inputMapping.season`. "Tabs for men and women" → `Tabs` + `when` panels or an input. "Load more" → `Pagination variant: more`.
- Card-match's pixel loop still works, because islands server-render their first state.
- The Assistant in the Builder and our agents can share one manifest, one prompt vocabulary and one validator.

## 8 · Order of work

1. **Registry and renderer catch-up (no new vocabulary).** A primitive registry with meta. Render Grid, Section, Carousel (scroll-snap, static), Tabs (static first tab), Countdown (static), Link, Tag and RichText on the server, plus the CSS for `reveal`. Contract tests. _Done when_ no placeholder renders for any current node type.
2. **The page runtime.** Extract the widget core (store, workflow, JSONata, cast-client) into a shared package. Add the `state`/`computed`/`data`/`workflow`/`props` envelope, `on`, `bind`, `visibleIn`, extended `when`, and the island boundary. Hydrate Carousel, Tabs and Countdown. _Done when_ a section with tabs filters a Cast list and polls every 15 s while live, and the server render is unchanged.
3. **Interactive primitives.** Select, Menu, Accordion, Dialog, Pagination, ScrollRow, Table, Progress, Skeleton. _Done when_ each has meta, a contract test and a behaviour scenario.
4. **Universal behaviour.** `motion` (replacing `reveal`), `hover` variants, `action` on containers, `pin`, `hideOn`, `slot`, `variants`. _Done when_ sticky headers and subnavs stack, cards are clickable, and reduced motion turns everything off.
5. **Media and forms.** Video, Embed (once there is a policy), AdSlot, Input, Checkbox, Switch, Form.
6. **The `Widget` node**, rendered through the page renderer's widget template path.

## Decisions to make

- **Converge the two DSLs?** Recommendation: yes, one behaviour model (the widget's) and one manifest. Our layout primitives are added to the widget catalogue over time, and the widget's interactive primitives to ours, with one name per concept. The alternative, two DSLs bridged only by the `Widget` node, is cheaper now but doubles the vocabulary the agents and the Assistant must learn.
- **Binding syntax:** `{{ }}` (the widget's) or `{}` (ours). It must be one before agents generate both.
- **React vs Preact for islands:** our renderer is React RSC and the widget is Preact. Recommendation: islands in React inside the RSC renderer, sharing the framework-agnostic core. The UI components are rewritten against our tokens anyway.
- **Who owns the shared core package:** it lives in `fanxp-web-renderer` today, while `@fanos/*` lives here (ADR 0020).
- **Embed policy** for YouTube and social iframes.
