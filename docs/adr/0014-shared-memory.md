# 0014 — Shared memory for every tenant and for each sport, promoted and approved

Date: 2026-10-30 · Status: accepted · Extends ADR 0013

## Context

After ADR 0013, memory belonged to tenants and the only knowledge every tenant shared was the agents' skills in git. An agent is generic, but much of what it learns about one cricket club's fixtures section holds for every cricket club. A club's own variation on top of that has to stay its own. Tenant lessons can hold a club's names, fixtures and editors' words, so nothing may cross tenants unseen.

## Decision

- **Three layers.**
  - global: every tenant reads it;
  - sport: every tenant covering that sport reads it. A tenant lists all the sports it covers (`sports` in `config/tenants.json`), so a multi-sport client such as an Olympics site belongs to many groups. A run reads the sports its input names when the agent says how (`sportsOf`, the sitemap's `sports`), otherwise every sport its tenant covers (`memoryGroups`);
  - tenant: as in ADR 0013.

  A run reads all three. On the same fact key, the tenant's wins over its sport's, and its sport's over the global one. The prompt also says a house fact wins over a shared rule that disagrees with it.
- **What is shared.** Facts and lessons. Run records always stay with their tenant.
- **Where it is stored.** Shared items are `memory_items` rows with no tenant and a `shared_scope` of `global` or `sport:<sport>`. `sources` lists the tenant items each was promoted from.
- **Row-level security, one policy per command.** A run reads its tenant's rows and approved shared rows, and writes only its tenant's rows. Only the admin role writes shared rows, and a proposal is invisible to every run.
- **Promotion** (`pnpm agent memory promote`, admin role):
  1. It finds pairs of similar items held by different tenants (cosine similarity 0.85 or more; lessons only within one agent) and groups them.
  2. It considers only groups that two or more tenants hold. The scope is the sport the tenants have in common. When they have several in common, the model names the one the point is about; with none in common, or "any", it is global.
  3. A model rewrites the group as one sentence naming no tenant. It replies NONE when the items describe each client, only share a topic, or set different values for the same thing.
  4. Code rejects any rewrite that names a tenant.
  5. Items already promoted are never proposed again.
- **The promotion model.** It is `sonnet-india` (`in.anthropic.claude-sonnet-5`) by default (`MEMORY_PROMOTE_MODEL`, a name in the model list of ADR 0015), which keeps tenant data in India. In tests on 2026-10-30, Nova Lite confused a club's own facts with shared rules; Sonnet 5 got every case right in 12 runs.
- **A person approves every shared item** with `pnpm agent memory review --shared`, which shows the tenant items it came from.

## Consequences

- `memory_items.tenant_id` is nullable (migration 007).
- Shared lessons don't expire. Their strength is the number of tenants they came from, and the prompt shows it as "from N clients".
- Promotion's model calls are not counted against any run's budget.
- Not yet:
  - promotion runs by hand, not on a schedule;
  - groups beyond sport (region, competition);
  - suggested skill edits (`.scratch/memory/issues/05-skill-suggestions.md`).
