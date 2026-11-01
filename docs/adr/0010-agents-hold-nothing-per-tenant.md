# 0010 — Agents hold nothing per tenant

Date: 2026-10-30 · Status: accepted

## Context

Each agent folder had per-tenant folders:

- `skills/tenants/<tenant>/<skill>.md`, appended to the skill as "Tenant notes" (ADR 0003). It was a second way to give a tenant's instructions next to house facts, and every file was a fact ("Readers are US soccer fans.").
- `data/<tenant>/style.json`, the house facts `agent.seed` loaded into memory (ADR 0007). Runs already read facts from Postgres, so the file was only starting data, but it made each agent own its tenants' facts.
- In match-preview, `data/<tenant>/fixtures.json` and `teams.json`, the sample sports data its tools read in place of a feed.

An agent is the same for every tenant. The run's tenant decides what memory puts in the prompt and what the tools read, so the agent's folder shouldn't need to know which tenants exist.

## Decision

- **Skills are per agent only.** `loadSkill(dir, name)` takes no tenant and there are no overrides. The tenant notes became house facts (`audience`, `style.opening`, `site.fan-zone` and others).
- **House facts are only memory.** The demo tenants' starting facts are in `config/tenants/<tenant>/facts.json`, keyed by agent id. `seedHouseFacts(store, tenantIds, agentIds)` in `@dugout/sdk` loads them, and `pnpm db seed`, the eval suites and tests call it. `defineAgent` no longer has `dataDir` or `seed`.
- **A tenant's sample sports data** is in `config/tenants/<tenant>/` too. It isn't memory: the tools read it live with the verified tenant id, as they will read the real feed.
- Facts are still scoped to a tenant and an agent. The store is unchanged.

## Consequences

- An agent folder is `src/`, `skills/`, `evals/` and `tests/`. Adding a tenant changes `config/`, not the agents.
- A tenant's instructions change through memory review, not a pull request to the agent.
- Skills are never dropped from the prompt, but facts are dropped whole when the memory budget runs out, so a former tenant note can now be dropped. With 5 to 7 facts per tenant and agent, that doesn't happen.
- Facts true of the whole tenant (spelling, audience) are stored once per agent: demo-cricket's audience fact is in both agents' facts. A tenant-wide scope is a store change, left for the memory work.
- A dev database seeded before this gets the former tenant notes as facts on the next `pnpm db seed`.
