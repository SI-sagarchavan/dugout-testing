# 04 · Decisions and valued facts in the store

Status: resolved
Type: task
Blocked by: 01

## What

- Migration `022_decisions.sql`: `episode_type` takes `'decision'`; `memory_items` gains `value jsonb` (null except for facts and decisions from answers); an index on `(tenant_id, key)` where `episode_type = 'decision'`.
- `packages/memory/src/store.ts`:
  - `recordDecision({ tenantId, agentId, question, section, name, answer, by, runId })`: key `<agent>:<id>@<section>`; the same answer to the same key adds to `strength` and moves `last_seen_at`; a different answer is a new row, so history stays and the latest wins.
  - `decision(tenantId, key)`: the latest for a key. `decisionsOn(tenantId, section)`: the latest per key on a section, any agent. `sectionsAnswered(tenantId, agent, id, value)`: how many sections got this answer, for promotion.
  - `proposeFact` and `activateFact` carry `value`; `fact(tenantId, key)` returns an active fact with it.
- Decisions expire like other episodes (`EPISODE_TTL_DAYS`); facts do not.
- Row-level security and `withTenant` as for every `memory_items` read.

## Done when

- Store tests cover reinforcing, a changed answer, latest per key, sections counted, and a valued fact read back; `pnpm check` passes.

## Comments

2026-11-08: migration `022_decisions.sql`; `recordDecision`, `decision`, `decisionsOn`, `sectionsAnswered`, `fact`, `listDecisions`, `reviseProposal`, `forgetEpisode`, `proposeFact` with `value` and `sources` (`packages/memory/src/store.ts`). Tests in `packages/memory/tests/decisions.test.ts`.
