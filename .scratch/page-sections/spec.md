# Sections that share a frame, then whole pages

Status: ready (2026-11-09). Supersedes the deferral in `.scratch/data-binding/sections.md`, whose
design this follows; the tickets here are what the evidence below adds to it.

## The problem

A designer hands off one frame that holds several sections over one background: the `Team` frame
(Figma 35:10501, export `1b10c408-e76d-4407-9282-ab2dee825d4e`) is a blue patterned background
(`D_Team`, a mask group of pictures, with the white wave at its foot) under "THE ROAD AHEAD"
(fixtures carousel, its own Cast hook) and "THE BRAVE SQUAD" (WOMEN/MEN tabs, player cards, arrows,
its own Cast hook). Later a whole page is handed off, and one builder per section runs in parallel,
then the page is put back together.

## What happens today

- `section-builder` runs `frame-match` once on the whole frame (fine: one tree, the background is
  continuous) and `bind` once. `bind` calls `agent.hookMaker` once and `bind.source` keeps one
  `source`, replacing the last. One section gets data; the other keeps the designer's copy. Run
  `69523f35` (4 Nov) did exactly this on this frame: "the run holds one data sample at a time".
- `findSections` (`packages/library/src/sections.ts`) on this IR returns four level-0 sections:
  `D_Team` (the background), the fixtures group `35:10541` (right), the squad heading row
  `35:10512` and the squad card row `35:10529` (one section, split in two); the arrows `35:10526`
  are dropped as too narrow. Causes: a full-width band "holds layers" even when it is only pictures;
  nothing joins loose siblings (the designer grouped fixtures, not squad). The pipeline does not use
  this finder at all.
- A writing child is keyed by its parent run only (`packages/sdk/src/subagents.ts`: `completed`
  by parent run id, child run id `attemptId(parent, child, attempt)`): a second `bind` call in the
  same pipeline is answered with the first one's result. Fan-out is impossible as it is.
- The data bag is already keyed by source name (`{ [as]: { castFlow } }`), so a plan can read
  `fixtures.castFlow…` and `squad.castFlow…` from one bag. But `bind.publish` records one `data`
  source in its meta, and Studio's `RunDataSchema.source` (`wnm-fanxp-frontend`
  `apps/surface-studio/src/shared-validation/surface.schema.ts`) is one object.

## Baseline run (2026-11-09)

`pnpm agent section-builder --tenant demo-cricket --export 1b10c408-… --yes`, run `4a1b41d4`
(frame-match `1dc74031`, data-bind `fc668eb2`, hook-maker `b1667c44`), $0.11.

- **frame-match completed**, 70.77% → 94.42%, on the whole frame as one tree. It found both
  carousels (fixtures and squad cards) and asked about each, and it recorded the squad's WOMEN/MEN
  tabs as a page-wide choice, `women_men` (initial `men`), with no owner: nothing stops the fixtures
  (whose items carry WOMEN/MEN) from being filtered by it. Its `content` is per frame: `some`, and every piece of
  evidence is from the fixtures cards (dates, times, scores). The squad shows up only as "repeats as
  a carousel". Preview: `http://localhost:3000/preview/default/76c682a1-2893-4e01-a55e-e8515d175386?…`
- **data-bind picked one section, silently**: it called `agent.hookMaker` once with
  `list: "squad players"`, hints `THE BRAVE SQUAD, WOMEN, MEN`, `must.team: Southern Brave`. Fixtures
  weren't in the need at all, and nothing in its output would have said so. On 4 Nov (run `69523f35`) the
  same frame got fixtures instead: which section wins depends on the model.
- **The run then stopped at setup**: `demo-cricket` has no Cast grant ("needs setup: no grant for
  tenant demo-cricket on http://localhost:4000/fanxp/api/v1/cast/mcp"), so no hook was looked up
  or bound. To finish the baseline after logging in:
  `pnpm agent data-bind --tenant demo-cricket --preview '<the preview above>'`.

What this adds to the tickets: per-slot content (05) is needed, not just nice to have, and until 09 lands, bind
should at least say in `remaining` which data areas it left unbound (09, interim step).

## Shape

Two levels, one finder:

- **Band**: a part of a page that stands alone (its own background, or none). One band is one
  `surface_section`, one `section-builder` run. Bands of a page run in parallel.
- **Slot**: a part of a band that shows one kind of data. A band with one background over two data
  areas (this frame) is one tree from one `frame-match`, with two slots. Each slot gets its own
  `bind` (its own hook, its own nodes); code merges the plans, which touch different nodes, and
  publishes once with every source in one data map.
- **Background**: layers a band paints behind its slots: never a section, never bound.

A slot owns: its heading row, its content, its controls (arrows, View more) and the choices it
draws (tabs, ADR 0032). **A choice belongs to the slot that draws it**: the squad's WOMEN/MEN tabs
filter the squad's cards, not the fixtures, even though the fixtures cards carry WOMEN/MEN badges.
ADR 0032 scopes every choice to the page (`packages/dsl/src/page.ts`: "the scope is the PAGE"),
which was right when the tabs' header and the cards were thought of as two sections; with slots,
the header is part of the squad slot. So:

- a choice's key is named for its slot (`squad_women_men`), so two slots' tabs never share state;
- a choice records its owner slot; only that slot's nodes read it, unless reading it from
  elsewhere was asked for on purpose (a designer note, or a person's answer). The page-wide
  `_page` mechanism stays: owning a choice is about who may read it, not where it is stored.

ADR 0032 gets an amendment saying so (ticket 05).

Only the orchestrating run asks a person anything (no approvals relayed through two levels of
children). Cast allows 25 live runs per hour per person, shared by all agents: hook look-ups run in
parallel and read-only, builds run one at a time under one approval, and the pass stops with a clear
message before the budget is gone.

## Tickets

In order; each says what blocks it.

1. `01-sections-eval.md`: the `Team` frame as a code-only eval case, expected answer written down
2. `02-section-finder.md`: background, heading + content + controls joined, one finder for both
3. `03-designer-section-mark.md`: a designer marks a section in the plugin; it overrides the finder
4. `04-ask-section-split.md`: when the finder is unsure, a person is asked, and it is remembered
5. `05-frame-match-slots.md`: frame-match answers with the band's slots, content per slot
6. `06-child-per-key.md`: a pipeline may call one writing child several times, in parallel
7. `07-bind-one-slot.md`: bind works on one slot's nodes only
8. `08-many-sources.md`: one data map with several sources, through publish, Studio and SCRE
9. `09-builder-fan-out.md`: section-builder binds each slot, merges, publishes once
10. `10-page-builder.md`: a whole page: bands in parallel, stitched (later)

## Live check after 05–09 (2026-11-09)

`pnpm agent section-builder --tenant sb --export 1b10c408-… --yes`, run `bf0b30f6`, $0.43, on a
fresh worker. (The baseline's `demo-cricket` has no Cast grant: Surface's backend keeps Cast
sign-ins by FanXP client code, and this design's client is `sb`.)

- **Both slots were bound in one preview**: `the-road-ahead` (9 props, 2 lists,
  `dugout_cricket_fixtures_by_date`) and `the-brave-squad` (5 props, 1 list,
  `dugout_cricket_squad_stats`, built in this run because `dugout_cricket_player_cards_full` lacks
  runs and strike rate). One plan, one data map (`fixtures`, `squad`). Frame match 70.77 → 94.42.
  Preview: `http://localhost:3000/preview/default/716852e8-c2f6-42f2-83c7-1c34099a5097?…&data=782cf291-…&plan=cd3dd3b1-…`
- **The choice belongs to its slot**: `the_brave_squad_women_men`, owner `35:10512`; the fixtures
  plan reads no choice.
- **Still off, data**: fixtures are IPL series 13469 (the schedule connector is fixed to it), all
  RECENT, so the upcoming card shape is never drawn; the squad feed has no photos and no gender
  field, so the toggle filters nothing; names don't split across two lines.
- **Still off, the agent**: the squad's bind asked for `must.team: "England"`, an inference from
  the placeholder players (Archer, Jordan), where the heading says THE BRAVE SQUAD (Southern
  Brave); the fixtures slot got it right. The data-bind skill should take `must.team` from the
  heading and the club's house facts, never from placeholder names. Its first `agent.hookMaker`
  call was refused for `count: 0`.
- **Still off, the frame**: dark card panels render white (no token near #565d87), countdown
  missing, edge fades unpainted, rotated role labels garbled, arrows drawn as small squares.
