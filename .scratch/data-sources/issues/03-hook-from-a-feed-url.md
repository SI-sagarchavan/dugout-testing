# 03 · Hook-maker builds a hook from a feed URL

Status: ready-for-human (built and tested; the live check below needs Cast and the Handoff)
Type: task
Blocked by: 01, 02

## What

With `need.sources`, hook-maker turns each URL into a connector, then builds the hook as it does
today (add an `api_call` step, transform, run, publish).

1. **Provider.** `cast_list_providers`; reuse one whose `baseUrl` is the URL's origin and path
   root. Else create one (`name: "dugout: <host>"`, `baseUrl`, `authMode: none`).
2. **Connector.** Split the URL: the path stays in `url` as `{{env.base_url}}/…`; each query
   parameter becomes `{{input.x}}` with the given value as its default when a page may vary it
   (`team_id`, `series_id`, `page_size`), a literal when it is the club's (`client_id`,
   `feed_format`, `lang`). Create it with `cast_upsert_api` (`name: "dugout: <what it gives>"`).
   Sources that differ only in their query values (women and men squads) are **one** connector.
3. **See it.** `cast_fetch_sample` with each source's values.
4. **Build** as today. Where the design has a choice the sources split by (WOMEN/MEN tabs), shape
   the output so the page can follow the choice: both lists side by side (`{ women: […], men:
   […] }`, two `api_call` steps) or one list with a `gender` field. Say which in `why`.
5. `final`: `built: true`, `covers`, and the connector and provider it created.

A source that is not `GET`, that answers non-JSON or an error, is reported in `missing` with its
status, and nothing is created for it.

## Done when

- Instructions and `skills/hook-maker.md` have the steps above (a "When a person gave the feed"
  section, before "When none fits").
- Live check: the Team frame's squad slot on tenant `sb`, given the two Southern Brave URLs, ends
  with a published `dugout_` hook whose output has both squads, and the preview shows Southern
  Brave players with the WOMEN/MEN tabs switching them.

## Pointers

- `agents/hook-maker/src/agent.ts` (instructions), `agents/hook-maker/skills/hook-maker.md`
- Feeds: `https://www.southernbrave.com/cricket/v2/series/squad?team_id=2034&series_id=15399&lang=en&feed_format=json&client_id=4ab1ce0f` (women), `team_id=2042&series_id=15397` (men)
- Page choices: `when` with `_page.<key>` (ADR 0032); the tabs write `_page.the_brave_squad_women_men`

## Comments

2026-11-09: instructions, `skills/hook-maker.md` ("When a person gave the feed") and the `created` output field are in; `agents/hook-maker/tests/build.test.ts` runs the feed flow against the fake hub (one provider, one connector for both feeds, the hook). The live check (the Team frame's squad slot on tenant `sb`, the two Southern Brave URLs, tabs switching the lists) was not run: it creates a connector, a provider and a hook on the shared dev Cast and needs the Handoff in the control plane.

2026-11-10: live check attempted and blocked, not run. It needs the Surface backend on :4000 (the Handoff `74cebc8c` and Cast's MCP, `CAST_MCP_URL` points there) and the dev DB tunnel on :9991 (SSM, `si-build` profile); both were down, and the local control plane holds no such Handoff. To run it: bring up the tunnel and the backend, `pnpm dev`, `pnpm worker`, then `pnpm agent section-builder --tenant sb --export <id>` with the two Southern Brave feeds in `feed.squad.*` facts.
