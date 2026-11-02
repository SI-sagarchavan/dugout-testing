# 04 · A club-site fetch tool (deferred; open-web search dropped)

Status: needs-info
Type: task
Blocked by: 03

Deferred on 2026-11-02. Open-web `web.search` is **not** planned: card-match and sitemap work on data
we own, and for sports content the open web is often stale, wrong or unlicensed. Spec: section D.

## What may come

A read-only `site.fetch` limited to a tenant's own domain, so sitemap can propose pages from what a
club's site really has. Added through 03 (an MCP manifest, or a small typed tool).

- Read effect, off unless a spec lists it.
- The URL goes through the policy and redactor, and must be on the tenant's allowed domain.
- Results are untrusted and capped, and stored by reference when long.

## Trigger to start

A tenant whose sitemap brief says "like our current site", and an answer to: may a tenant's
requests leave India?

## Done when

- Tests with a fake site: a URL off the allowed domain is refused; a page with instructions in it reaches the model as data.
- One live smoke run, cost recorded.
