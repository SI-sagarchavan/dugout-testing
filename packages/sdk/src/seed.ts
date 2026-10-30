import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TENANTS_DIR } from "@dugout/core";
import type { MemoryStore } from "@dugout/memory";

export interface HouseFact {
  key: string;
  content: string;
}

/** `<tenant>/facts.json`: facts for every agent of the tenant, and each agent's own (ADR 0013). */
export interface TenantFacts {
  shared: HouseFact[];
  agents: Record<string, HouseFact[]>;
}

/**
 * A tenant's starting house facts, from `<dir>/<tenant>/facts.json`; empty when it has none.
 * Memory holds the live facts: this is only what seeding and the evals start from.
 */
export async function houseFacts(
  tenantId: string,
  dir: string = TENANTS_DIR,
): Promise<TenantFacts> {
  let raw: string;
  try {
    raw = await readFile(join(dir, tenantId, "facts.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { shared: [], agents: {} };
    throw err;
  }
  const facts = JSON.parse(raw) as Partial<TenantFacts>;
  return { shared: facts.shared ?? [], agents: facts.agents ?? {} };
}

/** The starting facts one agent's runs see: the tenant's, with the agent's own winning on a key. */
export async function houseFactsFor(
  tenantId: string,
  agentId: string,
  dir: string = TENANTS_DIR,
): Promise<HouseFact[]> {
  const { shared, agents } = await houseFacts(tenantId, dir);
  const byKey = new Map([...shared, ...(agents[agentId] ?? [])].map((f) => [f.key, f]));
  return [...byKey.values()];
}

/**
 * Makes each tenant's shared facts, and the named agents' own, active semantic memory. Re-running
 * changes nothing. Returns how many facts changed per tenant and scope (a null agent is shared).
 */
export async function seedHouseFacts(
  store: MemoryStore,
  tenantIds: string[],
  agentIds: string[],
  dir: string = TENANTS_DIR,
) {
  const changes: Array<{ tenantId: string; agentId: string | null; changed: number }> = [];
  for (const tenantId of tenantIds) {
    const { shared, agents } = await houseFacts(tenantId, dir);
    const scopes: Array<[string | null, HouseFact[] | undefined]> = [
      [null, shared.length > 0 ? shared : undefined],
      ...agentIds.map((id): [string, HouseFact[] | undefined] => [id, agents[id]]),
    ];
    for (const [agentId, facts] of scopes) {
      if (!facts) continue;
      // only this scope's own facts: an agent's run would also see the shared ones
      const active = new Map(
        (await store.activeFacts(tenantId, agentId))
          .filter((f) => f.agentId === agentId)
          .map((f) => [f.key, f]),
      );
      let changed = 0;
      for (const fact of facts) {
        if (active.get(fact.key)?.content === fact.content) continue;
        const proposal = await store.proposeFact({
          tenantId,
          agentId,
          ...fact,
          confidence: 1,
          sourceRunId: null,
        });
        await store.activateFact(tenantId, proposal.id, "seed");
        changed++;
      }
      changes.push({ tenantId, agentId, changed });
    }
  }
  return changes;
}
