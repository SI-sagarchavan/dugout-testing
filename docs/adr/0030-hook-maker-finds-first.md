# 0030. One agent finds the hook, and builds one only when none fits

Date: 2026-11-06 · Status: accepted · Replaces `hook-finder` (ADR 0025, ADR 0026) · Related: ADR 0029

## Context

`data-bind` needed data from Cast and had two child agents for it. `hook-finder` (read and run, capability `hooks.choose`) looked through dugout's hooks and said what the best one covers and lacks. `hook-maker` (capability `hooks.author`) built a new hook. `data-bind` called the finder first and the maker only when the finder named no hook.

That split put a judgement in the wrong place. Whether a hook that gives part of what a design shows counts as a fit was decided by the parent's prompt, from the finder's list of what is missing. In a real run the only hook returned articles where the design showed videos. It counted as a fit, nothing was built, and the cards kept the design's placeholders. The finder had said so in `missing`, and a connector for videos existed.

`hook-maker` already began by listing its hooks and finishing one that fits, and `hooks.author` already grants every read and run tool the finder had. The finder was a second prompt and a second child run for the first half of the maker's own job.

## Decision

`hook-maker` is the one agent. It finds first, and builds only when nothing fits.

1. **Find.** List dugout's hooks, describe the best, run it with the transform applied, check every thing the design shows against its output. At most three runs.
2. **Decide.** A hook fits when its output has the fields the design shows, grouped as the design reads them. A hook is judged by its fields and grouping, never by its envelope. What no connector has (a ticket link, a countdown with no start time) does not make a hook not fit: it is listed in `missing`.
   - It fits: the agent answers with it and `built: false`, and creates, changes and publishes nothing.
   - None fits and a connector could give the rest: it builds. When a hook gave part of the need, it asks the person first, once (ADR 0029): what that hook gives and lacks, which connector would give the rest, to build a fuller hook or to use it as it is, with the build proposed. When no hook gave any of it, it builds without asking.
   - None fits and no connector could: `hookId: null`, `built: false`, everything in `missing`.
3. **Build** as before: create, call, run, transform, run with it, publish.

`built` is checked against what the run did, not taken on trust: it is true exactly when the run created or changed a hook. A hook that was found needs only a run with its transform applied in this run. A hook the run changed still needs that run after its last change, and a publish after that.

`hook-finder` and the `hooks.choose` capability are removed. `data-bind` calls `agent.hookMaker` once and gets a hook either way.

## Consequences

- The fit decision is in one prompt, with the facts it needs: what the hook returned and what the connectors could give.
- The call to `hook-maker` is a write, so it is approved per try (ADR 0025) even when the agent only finds a hook. Inside `section-builder` the one approval of `page.build` covers it, as it did the maker. Run on its own, `data-bind` shows a person the call whether or not anything gets built.
- A person can now steer a build: the question names the missing fields and the connector, so "articles instead of videos" is a choice made by a person, not a default.
- One fewer child run per data-bind run when a hook fits.
- `pnpm agent hook-finder` is gone: `pnpm agent hook-maker --need "…"` does both.
