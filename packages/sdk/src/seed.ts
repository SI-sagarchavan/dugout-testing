import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TENANTS_DIR } from "@dugout/core";
import type { MemoryStore } from "@dugout/memory";

export interface HouseFact {
  key: string;
  content: string;
}

/**
 * A tenant's starting house facts, from `<dir>/<tenant>/facts.json`; empty when it has none. Every
 * agent of the tenant reads all of them (ADR 0013). Memory holds the live facts: this is only what
 * seeding and the evals start from.
 */
export async function houseFacts(
  tenantId: string,
  dir: string = TENANTS_DIR,
): Promise<HouseFact[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, tenantId, "facts.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return (JSON.parse(raw) as { facts?: HouseFact[] }).facts ?? [];
}

/**
 * Makes each tenant's house facts its active semantic memory. Re-running changes nothing. Returns
 * how many facts changed, for each tenant that has facts.
 */
export async function seedHouseFacts(
  store: MemoryStore,
  tenantIds: string[],
  dir: string = TENANTS_DIR,
) {
  const changes: Array<{ tenantId: string; changed: number }> = [];
  for (const tenantId of tenantIds) {
    const facts = await houseFacts(tenantId, dir);
    if (facts.length === 0) continue;
    const active = new Map((await store.activeFacts(tenantId)).map((f) => [f.key, f]));
    let changed = 0;
    for (const fact of facts) {
      if (active.get(fact.key)?.content === fact.content) continue;
      const proposal = await store.proposeFact({
        tenantId,
        agentId: null,
        ...fact,
        confidence: 1,
        sourceRunId: null,
      });
      await store.activateFact(tenantId, proposal.id, "seed");
      changed++;
    }
    changes.push({ tenantId, changed });
  }
  return changes;
}
