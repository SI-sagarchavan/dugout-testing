# 17 · Hook-maker's checks judge fit, not presence; one provider per host

Status: resolved (2026-11-10, after review)
Type: task
Blocked by: none

## What

Three checks in the data path fire on the wrong signal. Each was seen in run `f77d8a76`, and each
would fire on any tenant.

1. **"Already there" refuses a needed build.** hook-maker's `final` was refused because
   `dugout_brave_fixtures` was built while `dugout_cricket_fixtures` existed
   (`agents/hook-maker/src/agent.ts:306`). The existing hook was about another team, and its own
   run said so. The guard looks at whether a hook exists, not whether it fits.
2. **The wrong-team check fires on the right feed.** `bind.try` said "nothing in the data names
   The Brave" on the club's own squad feed, which, like most squad feeds, never names its team. A
   person's feed, or a club fact's feed, was then reported as possibly another team's data.
3. **One host, two providers.** Hook-maker created "dugout: www.southernbrave.com" with base
   `…/cricket/v2` and "… v1" with base `…/cricket/v1`. A provider is a host, its auth and its
   shared parameters. Splitting by path version duplicates them and hides the reuse.

## Change

1. The "already there" guard fires only when an existing dugout hook **fits**, judged from
   hook-maker's own record: it ran that hook in this run and its `missing` names nothing that is
   `required` or in `must`. A hook about another team, or one lacking a required field, does not
   block a build, and `existing` says why.
2. Entity trust follows the source. When `bind.source`'s hook was built on `need.sources` (a
   person's feed or a club feed fact) or chosen by a person (`need.hook`), the source is about the
   design's entity unless the data names another one. In that case the check is "names another"
   rather than "names none". For any other hook, keep today's check.
3. Providers are reused by origin. hook-maker looks a provider up by URL origin (scheme and host),
   creates one with `baseUrl` set to the origin (plus the longest path prefix shared by every given
   URL of that origin), and puts the rest of the path in the connector's `url`. The skill says so.

## Done when

- hook-maker tests: an existing hook whose run shows another team doesn't block a build, and one
  that fits does. Two feeds on one host with different path versions give one provider.
- `facts.test.ts`: a sourced feed that names no team is not flagged, and one that names another
  team is.

## Pointers

- `agents/hook-maker/src/agent.ts` (the `final` guard, instructions), `agents/hook-maker/skills/hook-maker.md`
  ("When a person gave the feed"), `agents/data-bind/src/facts.ts` (`wrongEntity`),
  `agents/data-bind/src/tools.ts` (`bind.source` `about`)

## Comments

2026-11-09: done. (1) The "already there" guard counts only an existing hook whose own run in this run is about the design's entity (`wrongEntity` over the hook's observed output); one that shows another team does not block a build. I read "fits" as the entity check only: the per-field half would have needed paths for a hook the run never answered with. (2) `hook-maker` sets `basis` by code from what it was asked and did (`sources`, `chosen`, `found`, `built`); `bind.source` takes it, and a source built on a person's feed or chosen by a person is trusted: flagged only when the data names another team, never for naming none. (3) `feeds.plan` (a read tool, `agents/hook-maker/src/feeds.ts`) works out one provider for each origin with the shared path prefix as its base URL, one connector for each path, and literal-or-input query parameters, the same way every run; the skill says to create exactly what it plans and to reuse by origin first. Entity code moved to `agents/hook-maker/src/entity.ts` (data-bind imports it).

2026-11-09 review, reopened:
- **`basisOf` gives a found hook built on a person's feeds `"found"`** (`agents/hook-maker/src/agent.ts:304-308`): the club's feed facts go into `need.sources` for a second section, which finds the hook the first built; `bind.source` does not trust it. A found hook whose connector calls one of `need.sources` is `sources`.
- **The guard calls `wrongEntity` without `trusted` when `need.sources` is set** (`:397-400`): an existing hook on the same feeds that names no team counts as not fitting, and a copy is built.
- **`feeds.plan` base URL is not stable per origin** (`agents/hook-maker/src/feeds.ts:73-75`): a lone feed `/cricket/v2/series/squad` gets base `…/cricket/v2/series` (a version inside it); two squad feeds give base `…/v2/series/squad` and url `{{env.base_url}}`. Reuse by origin then calls the wrong URL; names collide. One provider per origin with base = the origin (no path), the whole path in the connector's url; reuse looks up by origin and base alike.
- **Query and URL edge cases** (`feeds.ts:80-88`): a value that looks like a secret (key, token, secret, signature, password, or a long random string) is never planned as a literal in a shared connector: it is reported, and the run asks for it as a `{{cred.name}}`; `https://u:p@…` is refused, not stripped; repeated params (`id=1&id=2`) are kept; `f[t]` becomes a safe input name; a param only one feed has is a literal on that call's overrides, not an empty input on the other; `/x/y/` and `/x/y` are not merged; values are kept encoded.

2026-11-10, review fixed: `basisOf` gives `sources` to a found hook whose described step calls one of `need.sources` (`callsSources`); the guard passes `trusted` for `need.hook` or a hook calling the sources. `feeds.plan`: one provider per origin (`baseUrl` = origin, path in the connector url, trailing slash kept); query params keep order, repeats and encoding; safe input names (`f[t]` → `f_t`); a param only some feeds have is set only on their calls; secrets (by name or a long random value) become `{{cred.<name>}}`, listed in `secrets`, masked in URLs, and the skill says to ask a person to add them in Cast; `user:pass@` URLs refused without echoing the password.
