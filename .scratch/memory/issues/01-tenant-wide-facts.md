# 01 · Tenant-wide facts

Status: resolved
Type: task

## What

A fact belongs to the whole tenant or to one agent.

- `memory_items.agent_id` may be null for a tenant-wide fact. One active fact per tenant, scope and key (`nulls not distinct`).
- An agent reads the tenant's facts plus its own; when both have a key, its own wins.
- `memory.propose` takes `scope: "tenant" | "agent"` (default agent). The reviewer sees the scope.
- Seed data: `config/tenants/<tenant>/facts.json` becomes `{ "shared": [...], "agents": { "<id>": [...] } }`. Facts that were copied per agent (audience, spelling) move to `shared`.
- `memory.search` returns tenant-wide facts too. Episodes stay per agent.

## Done when

- A fact seeded as shared reaches both agents' prompts; an agent fact with the same key overrides it for that agent only.
- Isolation tests still hold across tenants.
- `pnpm memory:review` shows `[tenant]` or `[<agent>]` for each proposal.
