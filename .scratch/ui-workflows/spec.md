# UI workflows: interactions, state, server state and tracking

Status: the state model is decided and built (ADR 0038, 2026-11-11): per-section machines on XState v5, a page of them, `$page`/`$user`/`$route`, `on`/`statesWhen`/`follow`. Still open: sources (§3.4), the write path (§5), tracking config (§6), the agent flow (§8). Becomes an ADR (superseding the mechanism of ADR 0032, keeping its rules) once the open questions below are settled.

## 1 · The case that started it

Southern Brave "My Account → Fan Preferences" (Handoff frame `D_Fan Pref`, preview `queue/2eddc30b-c06f-48dd-bfbd-d42c84be7388`):

- Page: "Favourite Player" (0/2, two slots) and "Followed Player" lists, a SELECT PLAYER button, an opt-in checkbox, a page SAVE.
- A second Figma frame shows the same page with a scrim and a **Select Players drawer**: search input, WOMEN | MEN tabs, a player list where each row has a star (favourite) and a circle (select), and a drawer SAVE.
- Wanted: pressing SELECT PLAYER opens the drawer; choices made there are added to the page's lists; the page SAVE does a POST. Then all related actions (remove a player, caps, errors) and tracking events.

The second frame is **not a second section**. It is the drawer-open state of the first page.

## 2 · Where we are today (checked in the repo)

- Page choices (ADR 0032): `select: { key, value }` on a node is one option of a choice; `Input` and `Checkbox` write a key; any node reads `_page.<key>` in `when` / `eqPath` / `over`. About 148 references across ~45 files (dsl `page.ts`, `runtime.ts`; renderer `client.tsx`, `context.ts`, `Input.tsx`, `Checkbox.tsx`; db `page-choices.ts`; compile `layout/lower.ts`; agents data-bind, frame-match, hook-maker).
- Actions in the DSL schema (`packages/dsl/src/field.ts`): `navigate | open | submit | custom`. `open` and `submit` have no target or payload behaviour yet (renderer support beyond `Button.tsx` not verified).
- Data reads: `data-bind` and `hook-maker` (Cast hooks). Writes: nothing.
- No client data runtime. `.scratch/dynamic-sdui/spec.md` §4 designs a hand-written `DataRuntime` (poller per source, pause hidden, backoff, stale-while-revalidate, BFF route).
- No TanStack or XState in the repo. The stack is already named in `.scratch/dynamic-sdui/from-widget-builder.md`: Radix, Swiper, our `{ }` binding, XState, TanStack Query, Next.js client components. `primitives.md`: no separate client runtime or island layer; interactive primitives are client components in the server-rendered tree.
- `@fanos/renderer` is React 19, RSC plus a `./client` entry built with `"use client"`, aimed at Next 15 App Router. It has no `next` dependency; the host provides Next. `.scratch/dynamic-sdui/spec.md` §7 lists the missing pieces: state store, more actions (`setState`, `toggle`, `scrollTo`, `refresh`, `track`), pagination, loading/empty/error states.

## 3 · Decisions leaned toward

### 3.1 One model for all interaction: a statechart

Tabs, drawers, inputs, submit and the rest are all one mechanism. The `_page` mechanism is replaced, not extended.

- **One root statechart per page** (XState v5 shape). Each tab group, drawer, input and request is a **region** (parallel state) or a **context field** inside it.
- **Authoring shorthand stays**: `select: { key, value }`, `Input`, `Checkbox`. The compiler lowers them into machine fragments. frame-match keeps emitting the shorthand, so the model never writes a statechart for a tab.
- **JSON only.** Guards and actions are names from a closed vocabulary; the runtime supplies the implementations (`setup()`). No inline functions, so the machine is data that agents can write, a validator can check, and it crosses the RSC boundary as props.
- **Why a machine, not flat keys:**
  - agents write a closed JSON shape well; the validator can find unreachable states, a `pending` with no `error` transition, an overlay that cannot close
  - parallel regions (drawer and submit) without a state explosion
  - `invoke` is the POST, and forces loading/error/success to be answered (Figma rarely draws them)
  - Figma prototypes are already machines: frames are states, reactions are transitions, so the `interaction` step can generate the machine from the design
  - the graph yields one Playwright path per route; Studio can draw it
- **Alternatives considered:** plain store plus JSON rules (Zustand-style; no parallel regions, `invoke`, or path generation); SCXML (same semantics, XML, no runtime we want); Redux/Zustand (nothing statically validatable). XState v5 chosen. Check first: bundle size (~15–20 KB gz) and SCRE (`@sikit/scre`, DSL copied verbatim) needing the same runtime. If SCRE cannot take it, write a small interpreter instead.

### 3.2 Rename `_page`; one read namespace

`_page.<key>` is only the name for "read this value from the page's store". We rename it, with one path resolver, and keep `_page` as a read alias only until stored trees are rewritten.

- Proposed: `$state.value.<region>` (a region's current state, e.g. `$state.value.women_men`, `$state.value.drawer`) and `$state.context.<field>` (data the machine carries, e.g. `$state.context.followed`).
- The `$` prefix keeps today's guarantee that the namespace can never collide with a data source (those start with a lower-case letter).
- `when`, `eqPath`, `over`, `heldBy` read `$state.…` through the one resolver; data binding does not change shape.
- No second namespace (`state.*` beside `_page.*`): one path only.

### 3.3 Sections are separate Handoffs: fragments

The header with the toggle and the strip under it are published by two runs. So each section contributes a **fragment** (regions, context fields, events, `emit` points). At page assembly, fragments merge into the root machine; a key collision is a validation error. Keys stay named for their slot (`squad_women_men`), as in ADR 0032's amendment.

### 3.4 Control state and server state are two layers

| Layer | Holds | Engine |
|---|---|---|
| UI state | tabs, drawer, draft selection, input text, submit phase | root statechart (`$state`) |
| Server state | the player list, fixtures, the fan's saved preferences, live scores | TanStack Query core (`@tanstack/query-core` plus a thin React binding) |

Rule: server data is never copied into machine context. The machine holds the **draft**; the saved list stays query data. The draft starts as a copy of the query data when the drawer opens.

What Query replaces from the hand-written `DataRuntime`: query key = (source, resolved inputs) for dedupe; `refetchInterval` as a function for `while`; `refetchIntervalInBackground: false` for `pauseHidden`; `retry`/`retryDelay` for backoff; placeholder data for `keep-last`; `dehydrate`/`hydrate` for SSR.

Write side: `submit` is a **mutation**. The machine's `pending` state invokes it; `onSuccess`/`onError` become events (`success`, `error`, plus `emit` for tracking). `invalidateQueries` refetches the fan's preferences after a save; optimistic update with rollback is available.

How they meet:
- a machine value or context field can be a query input (`"team": "{$state.value.women_men}"`), so a change gives a new key and a fetch
- a machine event can refresh a named source
- a query result can raise an event (polled `match.status` becomes `live`, the machine moves)

Declarative, no callbacks in the tree:

```json
{
  "sources": {
    "squad":   { "hook": "dugout_squad",
                 "inputs": { "team": "{$state.value.women_men}" },
                 "refresh": { "mode": "poll", "every": "duration.30s",
                              "while": { "path": "match.status", "in": ["live"] },
                              "pauseHidden": true, "onError": "keep-last" } },
    "myPrefs": { "call": "fan_prefs.get" }
  },
  "requests": {
    "savePrefs": { "call": "fan_prefs.save", "body": { },
                   "invalidates": ["myPrefs"] }
  }
}
```

Query is an implementation detail of the web renderer; the DSL says `refresh`, `invalidates`, `requests`. Native implements the same semantics with its own library. Fetches go through our own BFF route (`/api/data/:source`), cached per (hook, inputs) for `every` (100k fans polling cost one upstream call per interval; credentials stay server-side). The pixel harness needs a fixed clock and frozen data (`staleTime: Infinity`, no polling).

### 3.5 Next.js: no new package, `next` stays out of the renderer

The renderer already targets Next 15 App Router and has `"use client"` entries. Adding `next` as a dependency would break the Playwright pixel harness (renders without Next), SCRE as a second host, and native parity. The renderer uses React APIs only; Next-specific pieces are in the host.

SSR plus hydration flow:
1. Server component loads the tree and fragments, merges them into the root machine, computes the initial snapshot (`getInitialSnapshot`, from design defaults and the host's start values; this replaces `pageDefaults`).
2. A per-request `QueryClient` prefetches each source with `refresh` and the fan's own data, then `dehydrate`s it.
3. Machine config and snapshot cross the RSC boundary as plain props (why JSON-only matters).
4. Client provider (`@fanos/renderer/client`): `HydrationBoundary` for the query cache, and `createActor(machine, { snapshot })`. First client render equals the server's: no flash, no mismatch.
5. Takeover: polling starts, events fire, `invoke` calls the mutation.

| Piece | Where |
|---|---|
| Machine schema, validator, `$state` resolver, initial snapshot | `@fanos/dsl` (pure) |
| `StateProvider`, `QueryProvider`, hydration, tracking sinks and consent | `@fanos/renderer/client` |
| `/api/data/[source]`, `/api/actions/[name]` | host route handlers: tenant and fan auth, per-(hook, inputs) cache, write approval |

POST goes through route handlers, not Server Actions (works from any host and native). The BFF cache is managed explicitly, not through Next's fetch caching.

### 3.6 Overlays are page states

frame-match should recognise "same background, dim scrim, new panel anchored to an edge" and publish the panel as an overlay section that the trigger opens. The strongest signal is the Figma prototype reaction ("on click, open overlay"); the IR does not export reactions yet (listed as a gap in `dynamic-sdui/spec.md`). Until then a plugin note can mark it, as Section notes work today.

## 4 · The fan-preferences page in this model

| UI | Behaviour |
|---|---|
| SELECT PLAYER (page) | copy `followed` into `draft`, open drawer |
| Row circle | toggle id in `draft` |
| Star | toggle id in `favourite`, capped at 2 |
| Search | `Input` writes `q`; Repeater filters on `contains` |
| WOMEN / MEN | region of tab states |
| Drawer SAVE | commit `draft` to `followed`, close drawer |
| Empty slot / minus | Repeater over `followed` with an empty-slot item; minus removes |
| `0/2` | derived: length of `favourite` |
| Page SAVE | `submit` request, body built from state |

Question for the model to ask, not assume: drawer SAVE only commits locally and the page SAVE hits the API (my reading of the design). Others: max 2 favourites, replace or merge on Save, toast or inline on error, whether the drawer stays open on failure.

## 5 · The write path (POST)

- The browser never holds credentials and never gets a URL from the model.
- The tree says `submit` with a named request and a body built from state. The renderer posts to the host's action route; the host resolves tenant and the signed-in fan, then calls the real endpoint.
- Endpoints are a **registry entry per tenant** (like MCP's): method, effect `write`, body schema, success and error handling. Reads already have `dugout_` hooks; writes need an equivalent, tentatively `action-maker`, which finds a tenant connector endpoint or builds one with the same create-only rules as `hook-maker`.
- A person approves each write endpoint, and the approval shows the payload. Tests use a sandbox or dry run, never a live POST.
- Pending, success and error states come from defaults, and the agent asks when the design is silent.

## 6 · Tracking (GTM, Meta, GA4, others)

Machines emit **semantic events**; a per-tenant JSON config maps them to sinks. One interaction can feed several sinks, and a client changes mapping without touching the tree.

```json
{
  "sinks": {
    "gtm":  { "type": "dataLayer", "container": "GTM-XXXX" },
    "meta": { "type": "metaPixel", "id": "123" },
    "ga4":  { "type": "ga4", "id": "G-XXXX" }
  },
  "events": {
    "player_followed": [
      { "sink": "gtm",  "name": "follow_player", "params": { "player_id": "playerId" } },
      { "sink": "meta", "name": "AddToWishlist" }
    ]
  }
}
```

- A transition or action carries `emit: { name, params }` with params from context or the event (`{event.id}`, `len($state.context.followed)`). It names no vendor.
- Sink config is per tenant, read live through a tool (config is read live, not copied into memory). Sink types are a closed registry (GTM, GA4, Meta, TikTok, custom webhook) so every mapping can be validated.
- **Timing:** fire on the transition after the guard passes; a conversion event fires on `invoke.onDone`, never on the click; failures get their own event (`*_failed`); impressions and section views use the same mechanism, triggered by visibility.
- **Must build in:** consent gating (pixels only after the fan's consent; matters for a UK club); a validator that rejects PII in params (email, name); a debug view in Studio showing each event, and which sinks it went to.
- **Agent flow:** a client says "fire GA4 `add_to_wishlist` when someone follows a player"; the agent adds or edits the mapping and attaches the `emit` if missing; a person approves, because it touches the client's ad and analytics accounts (same rule as write-effect tools); decisions go to memory (ADR 0033).

## 7 · Rules and the expression language

A statechart moves between states but cannot decide anything without rules over data (budget ≤ 100, max 3 per club, exactly 11 players, captain in the XI, `0/2`). So the model needs a small, **safe, closed expression language** for guards and derived values over context and event data. No arbitrary JS. This is the biggest gap, and every condition on the page goes through it once the model is unified.

Scope (honest limits):
- In scope: forms, drawers, pickers, multi-step wizards, preference screens, team-builder flows with budget and count rules.
- Needs the bigger vocabulary: fantasy-style rules. Points, ranks and validity are computed by the server; the client machine guides and validates optimistically and the server's answer wins.
- Not a statechart problem: live data (data bindings), real-time play, physics, drag feel (a separate widget in code).
- Closed vocabulary means each new kind of rule extends the vocabulary. Keep an escape hatch: a `custom` action that calls a named server-side function, never model-written code in the page.

## 8 · Build experience (agents)

1. **Handoff** both frames (press Handoff on each, or select both and mark the link).
2. **`flow-builder`**: a parent like `section-builder`. Runs `frame-match` on the page and the drawer, then `data-bind` for the players (the squad hook exists), then a new **`interaction`** step that reads the frames and reactions and proposes the flow: regions, context, events, requests, `emit` points.
3. **The model asks only what the design cannot say** (see §4). Answers go to memory as decisions or facts (ADR 0033); no hard-coded asks (memory: questions come from the model, not code).
4. **`action-maker`** attaches the write endpoint; a person approves it.
5. **Verification:**
   - pixel match of each state against its Figma frame (drawer open equals frame 2)
   - a Playwright scenario generated from the machine's graph: click paths, state assertions, request payload asserted against a mock transport
   - the existing frames must not move (squad header stays at 94.81%)
6. **Studio, Flow panel:** states you can jump to, the machine diagram, state and query cache side by side, a timeline of events, requests and tracking events, "Try it" with the live POST gated behind confirmation. Comments on the flow go through `ui-editor`.

## 9 · Order of work

1. Machine schema in `@fanos/dsl`: regions, context, events, the closed action/guard vocabulary, `$state` addressing, fragment merge, validator rules. `select` shorthand lowered to it.
2. Run existing tabs, inputs and checkboxes on it with no visible change (squad header and other eval frames stay at their measured results). Remove `_page` after a read-alias period.
3. `sources` and `requests` schema (`refresh`, `invalidates`) and the renderer runtime: XState actor, TanStack Query core, SSR hydration. Measure the bundle, including SCRE.
4. Hand-author the fan-preferences tree and prove it end to end: players from a hook, draft in the machine, POST mocked.
5. frame-match detects overlay states; plugin note or reaction export for the link.
6. `interaction` step, then `action-maker` and the host action route.
7. Tracking config, `emit`, consent gate, Studio debug view.
8. Expression language growth as fantasy-style rules arrive.

## 10 · Open questions

- **Who hosts the fan-facing pages?** Studio's preview is a Next server component today. A fan-facing site is either a Next app (via wnm-fanxp-backend, CloudFront, ECS or other) or the legacy club sites embedding it. This decides where the route handlers and auth live.
- XState bundle size, and whether SCRE can take it (else a small own interpreter).
- Is the `$state.value.x` / `$state.context.x` naming final?
- Where tracking config lives (per tenant in `config/tenants/<tenant>/`, or in the database read through a tool) and who may approve changes.
- How a drawer's overlay section links to its trigger when there is no prototype reaction (plugin note wording).
- Sandbox/dry-run strategy for write endpoints per client.
- Fan identity at runtime (a `$user`-style read) for the preferences endpoints.
- Fragment merge across separately published Handoffs: key naming rules and what happens when one section is republished.

## 11 · Documents to write next

- An ADR superseding the mechanism of ADR 0032 (keeping its rules: slot-owned keys, first paint equals the design, a read is never checked against the tree's data) and covering the two layers and the line between them.
- Amend `.scratch/dynamic-sdui/spec.md` §4 (polling engine → TanStack Query) and §7 (state and interactions → machine).
- Update `CLAUDE.md` (`packages/dsl` page choices line) when step 2 lands.
