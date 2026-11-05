# Dynamic SDUI: from a Figma frame to a page that behaves like the website

Status: gap analysis, 2026-11-02. Nothing here is built yet. This file lists what the system needs so that a Figma send becomes a page with layout, data, live updates, sticky behaviour and motion, and not only a static picture that matches pixels.

## Where we are

Today's path is: Figma frame → IR → `@fanos/compile` → DSL tree → renderer → pixel diff → `frame-match` fixes the last 1–2% with overrides. All of it serves one goal: a static render that matches the screenshot.

What the code has now, layer by layer:

| Layer                                                  | Has                                                                                                                                                                                                                                                                                     | Missing                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Figma IR** (`surface-canvas/src/ir/schema.ts`)       | geometry, auto-layout `mode` and `wrap`, `clipsContent`, fills, text, `componentKey`, layer `name`                                                                                                                                                                                      | horizontal or vertical overflow scrolling, `scrollBehavior` (Figma's sticky and fixed position), prototype reactions and transitions (Smart Animate, easing, duration), component variant properties, Figma grid auto-layout, the designer's notes and annotations                                                |
| **DSL vocabulary** (`dsl/src/nodes`)                   | 18 node types, including `Carousel` (slidesPerView, peek, snap, loop, autoplay, controls), `Grid`, `Section`, `Repeater` (with `paginate`, which is schema only), `Tabs`, `Countdown`; the universal `reveal`, `revealDelay` and `when`; actions `navigate`, `open`, `submit`, `custom` | a place to say where data comes from (the tree binds `{news.items.0.title}`, and only Studio's manifest knows that `news` is a Cast flow); refresh and polling; sticky and pinning; motion beyond `reveal`; page state that a `Tabs` writes and other nodes and data inputs read; loading, empty and error states |
| **Compiler** (`compile/src/classify.ts`)               | emits 8 types: Box, Stack, Overlay, Text, Image, Icon, Divider, Button                                                                                                                                                                                                                  | Section, Grid, Carousel, Repeater, Tabs, Link, Tag, Countdown. Its header says Repeaters and bindings are left to the model on purpose. `proposeCollapse` exists in `@fanos/dsl` but only Studio and the CLI use it                                                                                               |
| **Renderer** (`renderer/src/components/Render.tsx`)    | Server Components only, with no `"use client"`. Draws those 8 plus Repeater; `reveal` adds a class                                                                                                                                                                                      | every other type draws a diagnostic placeholder. `.fos-reveal-*` has no CSS, so `reveal` does nothing. Nothing on the client: no carousel, tab state, countdown tick, polling or scroll behaviour                                                                                                                 |
| **Data** (`dsl/src/cast.ts`, `contract.ts`, `bind.ts`) | `fromCastFlow` normalises a Cast response, the B1–B7 rules check a tree against a sample payload, and `applyBindingPlan` applies a binding plan                                                                                                                                         | binding is done by hand (`fixtures/bindings/*.cast.plan.json`). No agent binds. The renderer is given data and never fetches it                                                                                                                                                                                   |
| **Cast tools** (`packages/mcp`, ADR 0022)              | reads: listHooks, describeHook, listApis, describeApi, getTemplateBinding; one write, `createHook`                                                                                                                                                                                      | the server can also add_step, wire_steps, set_transform, eval_jsonata, run_hook, lint, publish and set_template_binding. Without those an agent cannot _build_ a workflow, only find one                                                                                                                          |
| **Agent** (`agents/frame-match`)                       | visual repair through overrides, measured and undone when they make things worse                                                                                                                                                                                                        | it has no idea what a section _is_ (carousel, grid, list), what it _does_ (data, refresh, sticky) or how it _moves_                                                                                                                                                                                               |

In short, the vocabulary is ahead of both the compiler and the renderer. Most of the "dynamic" words exist in the schema, but nothing produces them and nothing draws them.

## What "dynamic" means here

A section is fully described by five things. Today we only produce the first.

1. **Look**: primitives, tokens and geometry. _Done, through compile and frame-match._
2. **Layout kind**: list, row, grid, carousel, tabs, hero, overlay, and the configuration for that kind.
3. **Data**: which Cast hook feeds it, with which inputs, bound to which nodes.
4. **Behaviour**: refresh and polling, sticky and fixed, interactions and state, pagination.
5. **Motion**: entrance, hover and press, transitions between states and slides, changes when data updates, scroll-linked effects.

The proposal adds a typed **Section Intent** between the design and the DSL. The agent decides _what_ the section is, as a closed typed object. Code turns that object into DSL primitives. The model never writes tree nodes or invents props, which keeps the "code first, the model only where judgement is needed" rule from `figma-to-dsl/spec.md`.

```ts
// one per Section. Every field is a closed enum or a token; zod-validated
SectionIntent = {
  sectionSrc: string,                       // Figma id of the Section
  layout:   LayoutIntent,                   // kind + kind-specific config
  data?:    DataIntent[],                   // sources and bindings
  behavior?: { refresh?, pin?, state?, paginate? },
  motion?:  MotionIntent,
  source:   { instructions: string[], evidence: string[] }   // why: designer notes + IR signals
}
```

## 1 · Layout detection

**The problem.** The compiler sees a horizontal Stack of five cards, with the fifth cut off by a clipping frame. That is a carousel, but today it compiles to a clipped Stack and the pixels still match. The pixel diff can never catch this, because a static screenshot of a carousel _is_ a clipped row.

**Signals, in the order to trust them:**

| Signal                                                                          | Source                                    | Needs IR change                  |
| ------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------- |
| The designer's instruction ("carousel, 3 per view, autoplay 5s")                | Figma annotation or plugin field (see §2) | yes                              |
| Figma `overflowDirection: HORIZONTAL` (prototype scrolling)                     | node property                             | yes                              |
| Figma grid auto-layout, or `layoutWrap: WRAP` with equal cells                  | node property                             | grid: yes; wrap is already there |
| Siblings that repeat by subtree signature, with the last one past the clip edge | `subtree-signature.ts` + geometry         | no                               |
| Arrow, dot or "1/5" components beside the row                                   | component name and key, `PrimitiveMap`    | no                               |
| Equal repeats aligned on both axes (rows × columns)                             | geometry                                  | no                               |
| A row of pills or underlines with one active variant above a panel → Tabs       | variant props + geometry                  | variant props: yes               |
| Layer and component names ("slider", "carousel", "rail")                        | `name`                                    | no                               |
| Prototype reactions: "on drag", "scroll to", "after delay" → autoplay           | reactions                                 | yes                              |

**Approach:**

- **Code proposes, the agent decides.** A `classifySection` function in `@fanos/compile` scores each candidate kind from the signals above and returns `{ kind, confidence, evidence[] }`. When confidence is high and nothing contradicts it, code accepts it. When confidence is low or the signals conflict, the agent looks at the crop (`frame.look`) and decides, and writes its evidence down.
- **Repeaters come before layout.** A carousel or grid is a container _of a Repeater_. Wire `proposeCollapse` into the run (step 2 of `figma-to-dsl/spec.md`) before classification.
- **Lowering is code.** `carousel` → `Section > Carousel > Repeater > card template`; `grid` → `Grid{columns, gap} > Repeater`; `list` → `Stack{column} > Repeater`. Each is a pure function from intent to flat nodes, tested on fixtures.
- **Breakpoints.** One frame is one breakpoint. `slidesPerView`, `columns` and `direction` are already responsive (`resp: true`). Either the designer sends desktop and mobile frames together and the run matches sections across them by `src` and name, or the instruction says it ("1.2 per view on mobile"). Both should be supported; the instruction wins.

## 2 · Natural-language configuration

The designer (or an editor) writes English. The agent turns it into the typed config of the layout kind. Unknown requests are reported, never invented.

**Where the English lives** (an open decision; the recommendation comes first):

1. **Figma annotations** (Dev Mode annotations, which the plugin API reads as `node.annotations`). They sit next to the design, are versioned with it and already exist in designers' workflow. The plugin exports them into the IR as `notes[]` per node.
2. A **"Behaviour" field in the plugin** per selected section, stored in plugin data and exported the same way.
3. **Studio**, after the fact, for editors: an instruction box per section that queues a run limited to that section's intent.

**Example:**

> "Carousel. 3 cards per view on desktop, 1.2 on mobile with a peek. Loop, autoplay every 5 seconds, pause on hover. Dots below, centred. Arrows on the edges only on desktop."

becomes

```json
{
  "kind": "carousel",
  "config": {
    "slidesPerView": { "base": 1.2, "lg": 3 },
    "peek": "space.md",
    "loop": true,
    "autoplay": "duration.5s",
    "pauseOnHover": true,
    "controls": ["dots", "arrows"],
    "controlsPlacement": "below-center",
    "controlsAt": { "arrows": ["lg"] }
  }
}
```

`pauseOnHover` and `controlsAt` are **not** in today's `Carousel` schema. That is the point: when the English asks for something the vocabulary cannot say, the agent returns a `vocabularyGap` (the request, the node, the closest supported config) and applies the closest config. A person decides whether the vocabulary grows. Gaps are collected across runs, and that collection is the backlog for the DSL.

**What is needed:**

- A zod config per layout kind, kept in `@fanos/dsl` next to the node specs, so the intent schema and the node schema cannot drift.
- An `intent` skill: how to read instructions, the defaults per kind, and the rule that instructions beat signals, signals beat defaults, and every choice cites its evidence.
- A tool `section.intent.set({ sectionSrc, intent })` that validates, lowers, renders and diffs (the static first frame must still match), then returns the new version.
- An approval when the intent changes structure (for example a Stack becomes a Carousel). Changing only the config does not need one.

## 3 · Data: the agent finds or builds the workflow

**Target flow per data section:**

1. **What data does this need?** From the content (dates, "vs", score shapes, article cards, standings tables), names, and the instruction ("latest 6 news articles for this team"). Output: a _data need_, `{ entity: "news" | "fixtures" | "standings" | …, filters, count, fields[] }`.
2. **Find.** `cast.listHooks` and `cast.describeHook` look for a hook whose output fields cover the need. Prefer reuse: the tenant's existing published hooks first.
3. **Build when none fits** (needs new typed tools; ADR 0022 says each one is written out): `cast.listApis` → `createHook` → `addStep` per connector → `wireSteps` → `runHook` for real responses → `evalJsonata` until the output has the shape the section binds → `setTransform` → `lint`. Everything saves as a **draft**. Publishing (`cast.publishHook`) and attaching (`cast.setTemplateBinding`) are separate write tools, each behind approval.
4. **Bind.** The agent produces a `BindingPlan` (the format already exists in `bind.ts`) against the hook's sample output. The B1–B7 rules check it, and the render is diffed with real data. Bind to `items`, never to `data.1`.
5. **Declare** the source in the tree (see below), so the renderer knows what to fetch.

**DSL changes:**

- A `data` block on the tree envelope (or on `Section`), next to `nodes`:

  ```json
  "data": {
    "news": { "source": { "kind": "cast-hook", "hook": "cms-listing", "version": "published" },
              "inputs": { "team": "{page.teamId}", "limit": 6 },
              "refresh": { "mode": "none" } }
  }
  ```

- `source.kind` is a closed union. `cast-hook` comes first. `static` (inline sample, for previews and tests) is next. A third kind (`http` through an allow-listed BFF route, or another workflow engine) is added only when a real case needs it. This is the "if not Cast, something else" answer: the tree names a _source kind_, the renderer has one adapter per kind, and the agent only ever picks among registered kinds.
- `inputs` may read page params and page **state** (`{state.gender}`). That is how a Tabs toggle (men/women) refetches the section. It is the main link between interaction and data.
- A validator rule: every top-level path that a binding uses must have a declared source.

**Contract:** `contract.ts` says "the sample is the contract until Cast hands us the hook's output schema". Ask the Cast team for an output schema per published hook. Until then, `runHook` gives the sample, and it is stored with the tree version.

**Permissions:** Cast MCP calls run as the person who logged in (ADR 0022). Building hooks writes shared connectors, so every write stays approval-gated, and connector writes (`upsertApi`, `upsertProvider`) should stay out of the agent's tools entirely at first.

## 4 · Live data: the polling engine

**Need.** A live score, a match centre, a lineup that appears 60 minutes before kick-off, standings during a round. The page must update without a reload, and must stop when it no longer matters.

**DSL**, on each data source:

```json
"refresh": {
  "mode": "poll",                      // none | poll | stream (later) | revalidate (ISR)
  "every": "duration.15s",             // a token; a per-tenant minimum is enforced
  "while": { "path": "match.status", "in": ["live", "ht"] },  // the existing predicate grammar
  "pauseHidden": true,
  "onError": "keep-last"               // keep-last | show-error
}
```

**Renderer runtime:** this is a new piece. The renderer is RSC only today.

- **First paint stays on the server**, with data, for SEO and speed. Sections whose sources have `refresh.mode != none` render inside a client **data island**.
- **A single client `DataRuntime`** per page: one poller per _(source, resolved inputs)_, shared by every section that reads it; pauses when `document.hidden`; exponential backoff with jitter on errors; stops when `while` turns false; keeps the last good value; stale-while-revalidate.
- **Fetch through our own BFF route** (`/api/data/:source?inputs`), never straight to Cast from the browser. The route caches per (hook, inputs) for `every`, so 100k fans polling cost one upstream call per interval. Credentials stay server-side.
- **Re-render only the bound subtree**: the island owns its section, and a data change rerenders it with the same `Render` logic (resolution is pure, so server and client share code).
- `Countdown` needs the same client runtime (a ticking clock), and its `onZero` could trigger a source refresh (kick-off → start polling).
- **Later, `stream`**: SSE or WebSocket for very live feeds (ball-by-ball). The DSL shape stays the same and only the transport changes.
- **Native parity**: the same `refresh` semantics must be implementable on native. Keep it declarative, with no callbacks in the tree.
- **Harness**: the pixel harness needs a fixed clock and a frozen data snapshot so renders stay deterministic.

## 5 · Sticky and scroll behaviour

**Source.** Figma's prototype position setting (`scrollBehavior`: `SCROLLS`, `FIXED`, `STICKY_SCROLLS`) per layer. Export it in the IR. The instruction can also say it ("sticky subnav under the header", "hide header on scroll down").

**DSL**, a universal `pin` prop (or Section-only, to start):

```json
"pin": { "mode": "sticky", "edge": "top", "offset": "space.0",
         "scope": "page",                 // page | section (sticks only while its section is on screen)
         "onScroll": "hide-down-show-up" } // none | hide-down-show-up | compact
```

- `mode: fixed` covers floating elements (a "Buy tickets" bar, back-to-top).
- `onScroll: compact` switches the node to a named variant past a threshold: a smaller header, a logo that collapses. This needs node **variants** (a small, closed `variants` map of prop overrides keyed by state), and the same mechanism serves hover and active tabs (§6).
- **A sticky stack**: two sticky things (header, then subnav) must not overlap. The renderer keeps a page-level stack and offsets each later pin by the earlier pins' heights through CSS variables.

**Renderer:**

- `sticky` and `fixed` are CSS and work in RSC with no JS. `hide-down-show-up` and `compact` need a tiny client scroll observer (one per page, passive, rAF-throttled).
- **New validator rule**: a sticky node cannot have a clipping (`clip: true` or `overflow: hidden`) ancestor between it and its scroll container, because sticky silently fails there. `clip` is common in compiled trees, so this rule will fire. Better to know at validation time.
- **Verification**: Playwright screenshots at several scroll offsets (0, half the page, the end of the section) and checks of the pinned node's bounding box.

## 6 · Animation and motion

**Today**: `reveal` (`fade`, `fade-up`, `scale`) and `revealDelay` exist in the DSL. The renderer adds a class with no CSS behind it, so nothing animates. Carousel `autoplay` is schema only.

**Kinds of motion a sports site needs:**

| Kind                | Examples                                                                            | Source in Figma                                                  | Implementation                                                                  |
| ------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Entrance            | cards fade up as they scroll in, staggered                                          | instruction                                                      | CSS `animation-timeline: view()` where supported, IntersectionObserver fallback |
| Hover, press, focus | card lift, image zoom, button fill                                                  | interactive component variants ("while hovering", Smart Animate) | CSS transitions between `variants`                                              |
| State transitions   | carousel slide or fade, tab panel switch, accordion                                 | prototype transitions on the component                           | part of the Carousel and Tabs components, configured by intent                  |
| Data change         | score changes and flashes, numbers count up, "LIVE" dot pulses, a new row slides in | instruction                                                      | the client island animates on value change                                      |
| Scroll-linked       | parallax hero, reading progress bar                                                 | instruction                                                      | CSS scroll-driven animations                                                    |
| Authored animation  | Lottie or Rive logo, celebration                                                    | an exported asset                                                | a new `Animation` leaf (asset token, loop, autoplay, play on view), or `Custom` |

**DSL**, replacing `reveal` with a richer `motion` prop (keeping `reveal` as an alias):

```json
"motion": {
  "enter":  { "preset": "fade-up", "duration": "duration.md", "easing": "easing.out", "stagger": "duration.xs" },
  "hover":  { "variant": "raised" },
  "update": { "preset": "flash" }
}
```

- Presets are a **closed list** that every renderer implements identically, like pipes in `binding.ts`. No free CSS and no keyframes from the model.
- **Easing tokens** are new in `@fanos/tokens` (`easing.*`; durations already exist). Read them from the theme export where the design system has them.
- `prefers-reduced-motion` is honoured by the renderer, always, and is not a choice for the tree.
- Autoplay must pause on hover and focus and have a pause control (WCAG 2.2.2). Make that a validator rule.

**Verification**: the pixel diff runs with motion off (final state). Behaviour checks in Playwright assert that the class or state changes after scroll, hover or time, and optionally record a short video for review.

## 7 · State and interactions

`Tabs` writes a state key (`bind`) today, but nothing reads it.

- A page **state store** (client-side, keyed, with initial values in the tree). `when` can read `state.*`, so tab panels show and hide. Data `inputs` can read `state.*`, so a filter refetches.
- More actions in the closed `action` union: `setState`, `toggle`, `scrollTo` (an anchor), `refresh` (a source), and `track` (an analytics event; every action should carry an analytics name).
- `Repeater.paginate` (`more`, `infinite`, `pages`) is implemented on top of the data runtime: page N is an input to the source, and `fromCastFlow` already joins pages together.
- Loading, empty and error states per data section: a skeleton, derived from the card template at its first render, and an empty message from the instruction or a default.

## 8 · Orchestration: how one run does all this

One Figma send is still one run (decided). Sections are tasks inside it (harness-orchestration). Per section:

| Step                                                 | Who                                       | Tools                                          |
| ---------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| 1 compile + repeats                                  | code                                      | `@fanos/compile`, `proposeCollapse`            |
| 2 classify the layout                                | code proposes, agent confirms when unsure | `classifySection`, `frame.look`                |
| 3 intent from instructions + signals                 | agent (`intent` skill)                    | `section.intent.set`                           |
| 4 lower intent → DSL                                 | code                                      | pure lowering per kind                         |
| 5 data: find or build the hook, then bind            | agent (`binding` skill)                   | `cast.*` reads; draft writes behind approval   |
| 6 behaviour + motion from intent                     | code (lowering), agent only for gaps      | —                                              |
| 7 visual repair                                      | agent (today's `frame-match`)             | `frame.*`                                      |
| 8 behaviour checks                                   | code                                      | Playwright scenarios generated from the intent |
| 9 review: Figma, render, live preview with real data | person                                    | the existing approval flow                     |
| 10 publish tree + hook + template binding            | code, after approval                      | `cast.publishHook`, `cast.setTemplateBinding`  |

Agents are split by job (intent, binding, repair), not by section type, as `figma-to-dsl/spec.md` already decided. Run hooks (ADR 0023) are where per-step gates go: no publish until the behaviour checks pass, and no binding before intent is set.

## Order of work

Each phase is usable on its own. The order follows dependencies: nothing downstream can be verified until the renderer draws it.

1. **The renderer catches up with the vocabulary.** Section, Grid, Carousel, Tabs, Countdown, Link, Tag and RichText, plus the client island boundary and the reveal CSS. _Done when_ every node type renders with no placeholder, and Carousel and Tabs work in the browser.
2. **A richer IR.** Overflow direction, `scrollBehavior`, reactions and transitions, variant properties, grid auto-layout and annotations, exported by the plugin. _Done when_ a fixture of each kind round-trips through the IR with these fields.
3. **Layout detection and intent.** `classifySection`, `SectionIntent` schemas, lowering, the `intent` skill and agent, and `vocabularyGap` reporting. _Done when_ an eval set of about 30 sections (carousel, grid, list, tabs, hero) classifies at ≥90% and English instructions lower to the expected config.
4. **Data sources and binding.** The `data` block in the DSL, Cast tools for build, run, transform, publish and template binding (all writes behind approval), and the binding agent. _Done when_ a news section with no hook ends with a draft hook, a bound tree and a live-data preview, each after one approval.
5. **The live runtime.** DataRuntime polling, the BFF route with a shared cache, `Countdown` ticking, `while` stop conditions, and pagination. _Done when_ a mock live match updates on the page, pauses when the tab is hidden and stops at full time.
6. **Pin and motion.** `pin`, the sticky stack, scroll observers, `variants`, `motion` presets, easing tokens and the validator rules (sticky under clip, autoplay without a pause control). _Done when_ behaviour checks pass at several scroll offsets and hover states.
7. **Behaviour evals and review.** Scenario checks generated from intent, and a review view with a live preview. _Done when_ `pnpm eval` gates on behaviour as well as on pixels.

## Decisions to make (each likely an ADR)

- **Where instructions are written**: Figma annotations (recommended), a plugin field, or Studio. Possibly all three, with one precedence order.
- **The client runtime**: React client components as islands inside the RSC renderer (recommended: the same resolution code, and Next already supports it) or a vanilla script. Either way, the server keeps the first paint.
- **Polling vs push**: polling through a caching BFF first; SSE or WebSocket only for feeds that need updates in under 5 seconds.
- **Who may build Cast hooks**: agent drafts and a person publishes (recommended), or only reuse of existing hooks at first. Connector and provider writes stay out of reach.
- **Native parity**: is every new prop (`pin`, `motion`, `refresh`, `variants`) required on native from day one, or tagged `platform: ["web"]` until native catches up?
- **How the vocabulary grows**: who reviews `vocabularyGap` reports and how often. This is what keeps the closed vocabulary from becoming a bottleneck.
- **Ask Cast for hook output schemas**, so binding is checked against a contract and not a sample.
