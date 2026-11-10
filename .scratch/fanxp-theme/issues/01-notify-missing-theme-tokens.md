# Notify a person when a Handoff needs something the FanXP theme lacks

Status: needs-triage

## What

frame-match builds every Handoff against the tenant's active FanXP theme (`GET /surface/service/theme`
on the FanXP backend). Two things it cannot fix itself:

- **No active theme** (or one with no tokens): the run ends `needs setup: an active FanXP theme for <tenant>…`.
- **A gradient the theme has no token for** (Southern Brave's fixtures-strip edge fades, Handoff
  `40108dd5`): the layer is drawn as its own picture from the export, a see-through PNG of exactly
  the fade, and listed in the output's `noToken`. The stand-in stays until someone adds the token
  to the FanXP theme; the next Handoff then paints it with the token, with no code change.

Today both are only in the run's output (`noToken`, `remaining`, the needs-setup reason).

## Wanted

Send each one to a Slack channel (to be connected) so the theme owner hears about it without
reading run output:

- tenant, Handoff id, preview link
- for each `noToken` layer: layer name and id, the gradient (angle, stops), and a suggested token
  name; the clip it stands in with
- for a missing theme: which client, and that its sections are not being built

One message per run, not per layer. Not repeated for the same layer and gradient on the next
Handoff of the same frame while the token is still missing.

## Open

- Which channel, and whether it is per tenant
- Who sends it: the worker after a run ends (it has the output), or the FanXP backend
