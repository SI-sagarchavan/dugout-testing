# 01 · Memory belongs to the tenant

Status: resolved
Type: task

## What

An agent is one definition that every tenant's runs use; it owns no memory.

- Facts, lessons and run records belong to a tenant. Every agent of the tenant reads all of them; row-level security keeps other tenants' rows out.
- `memory_items.agent_id` records which agent's run produced an item (null when seeded). It is shown to reviewers and gives an agent's own lessons a small ranking lift. It never hides an item.
- One active fact per tenant and key (migration 006). Concurrent activations of a key take turns under an advisory lock.
- `memory.propose` has no scope: every fact is the tenant's, so its text says what it applies to ("Match previews: at most 120 words").
- Seed data: `config/tenants/<tenant>/facts.json` is `{ "facts": [...] }`.
- Global memory is the skills in git. Lessons reach it as suggested skill edits (issue 05), through a pull request.

First built as tenant-wide facts beside per-agent ones (migration 004); changed the same day on the decision that memory is never agent-owned.

## Done when

- A fact proposed by one agent reaches every agent's prompt for that tenant, and no other tenant's.
- A lesson from one agent reaches the others, ranked a little lower than their own.
- Two activations of one key at once leave one active fact.
