# Data sources: getting a section's real data, every time

Status: ready (2026-11-09). Tickets in `issues/`, in the order to pick them up.

## The problem

The frame side is good (98.7% on the Team frame, from 70.9%). The data side is where Handoffs go
wrong: wrong data published as bound, runs that fail, a person's answer dropped.

Run `3acd204c` (Handoff `74cebc8c-6cfc-4fba-9174-f4d5fb83bb46`, tenant `sb`, the Team frame,
9 Nov) shows all of it:

- Both slots were bound to the wrong team: fixtures to IPL 2026 men's matches, the squad to an IPL
  franchise (Glenn Maxwell, …). `page.build` and the thread note say `data: "bound"`; the wrong team
  is only in `remaining`.
- The first squad bind failed `invalid_output`: hook-maker found nothing, and data-bind had no legal
  way to end a slot without a plan (`final` refused twice, `bind.done` refused), so `page.build`
  failed and was retried whole.
- On the retry data-bind asked, and the person gave the two Southern Brave squad feeds (women
  `team_id=2034&series_id=15399`, men `team_id=2042&series_id=15397`,
  `https://www.southernbrave.com/cricket/v2/series/squad?…&client_id=4ab1ce0f`). The next
  `agent.hookMaker` call got the earlier child's answer back in 0 s (run `e6fc38d5`, never re-run),
  and data-bind then wrote that hook-maker "could not build from the URLs you gave".
- Even re-run, hook-maker could not have used them: it builds only on existing connectors
  (`cast_add_step` takes an `apiId`), and the tools that create one are not granted to us.

Last 14 days: data-bind failed 26 of 65 runs (22 `invalid_output`); hook-maker answered no hook in
18 of 42 and built one in 7. Neither agent has an eval suite.

## What Cast already has

The live server (`cast` 0.5.1) has 10 tools our registry does not list (`pnpm agent mcp sync cast
--check`: "10 on the server not listed (unreachable)"). The ones this needs:

- `cast_list_providers` (read): providers, base URL, auth mode, env var keys.
- `cast_upsert_provider` (write, destructive): create (`name`, `baseUrl`, `authMode`, `envVars`,
  `defaultQueryParams`, …) or update by `id`.
- `cast_upsert_api` (write, destructive): create a connector under a provider (`providerId`,
  `name`, `url` like `{{env.base_url}}/series/squad`, `method`, `queryParams`, `headers`) or update
  one by `id`. Connectors are shared: an update changes every hook that calls it. Secrets only as
  `{{cred.name}}`.

Not to be granted: `cast_delete_api`, `cast_delete_provider`, `cast_delete_hook`,
`cast_duplicate_hook`, `cast_revert_hook`, `cast_set_template_binding`,
`cast_delete_template_binding`.

So no ask to the Cast team: the fix is ours.

## Three layers

1. **Supply.** The data must be reachable: a person can give a feed URL and hook-maker turns it
   into a connector, a hook and a transform (tickets 01–03). A club's feeds are known once and kept
   (07).
2. **The handoff between steps.** A child that finished is re-run when what it is asked changes
   (04). The need is built by code from the IR, typed, and its fit is checked by code (08).
3. **Endings and checks.** A slot ends as `bound`, `stand-in` or `none`, never by failing (05);
   `bind.try` checks the data is about the design's team, in the design's format, and draws every
   variant (09). An eval suite measures all of it (06).

## Order

01 → 02 → 03 and 04 unblock the Southern Brave case end to end; 05 stops runs failing; 06 is the
gate every later change is measured against; 07–09 follow.

## Round 2 (2026-11-09): what run `f77d8a76` showed

Handoff `07403d4f-dda0-434f-92e0-047dc4bda60d`, compared with southernbrave.com. 01–05 worked: real
Southern Brave data in both slots, connectors built from feeds, and no failed run. What a person
still sees wrong is in tickets 10–17:

- 10: dates a day out on machines east of UTC, and no rule for the display zone
- 11: every question is the model's: tools report what is open (evidence, candidates, what they
  can take), the agent asks, answers return as tool input, memory learns them by id; no question
  text in code (frame-match's layout and split questions, section-builder's budget question and the
  approval's wording included)
- 12: shared writes (connectors, providers) shown to a person even under one approval
- 13: a list follows the page choice that filters it (tabs, toggles, filters)
- 14: the hook gives what the design shows, in its form (units, splits, codes, per-item fields)
- 15: which items, in what order, grouped as the design groups them
- 16: a per-item picture is never kept silently (id → URL facts, `picture_url`)
- 17: hook-maker's checks judge fit, not presence; one provider per host

10, 11 and 13 are what a person notices first.

## Rule for every ticket here: generic, not this frame

The Team frame and Southern Brave are the evidence, never the target.

- No code, skill text or instruction names a club, a frame, a node id, a field name from one feed
  (`gender`, `overs`) or a sport's rule. Those are examples in a ticket, or house facts per tenant
  (ADR 0010).
- Each fix's tests use at least two unrelated shapes (another sport or content type: news,
  videos, standings, events), and at least one that is not cricket.
- A fix is measured on the eval suite (06): no case gets worse. A case is added when the fix
  covers a kind of design the suite does not have yet.
- No question a person sees is written in code (ticket 11). A fix that needs a person's input
  reports it as an open item with evidence, and the agent asks. A question that comes out wrong is
  mended through the skill's description of the open item and through memory, never by fixing
  its words in code.
- Where the fix needs a club's value (a zone, a URL pattern, a date order), it is a house fact
  with a neutral default, and a person's answer proposes it (ADR 0033).

## Out of scope here

The pale section titles on the Team frame (frame-match scoring rewards the wrong token; a
frame-match ticket of its own).
