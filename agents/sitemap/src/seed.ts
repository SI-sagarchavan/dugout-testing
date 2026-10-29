import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryStore } from "@dugout/memory";
import { spec } from "./agent.ts";

export const DATA_DIR = join(import.meta.dirname, "..", "data");

/** Makes each tenant's `style.json` facts the active semantic memory. Re-running changes nothing. */
export async function seedHouseFacts(store: MemoryStore, tenantIds: string[], dataDir = DATA_DIR) {
  const changes: Record<string, number> = {};
  for (const tenantId of tenantIds) {
    const file = join(dataDir, tenantId, "style.json");
    const { facts } = JSON.parse(await readFile(file, "utf8")) as {
      facts: Array<{ key: string; content: string }>;
    };
    const active = new Map((await store.activeFacts(tenantId, spec.id)).map((f) => [f.key, f]));
    changes[tenantId] = 0;
    for (const fact of facts) {
      if (active.get(fact.key)?.content === fact.content) continue;
      const proposal = await store.proposeFact({
        tenantId,
        agentId: spec.id,
        ...fact,
        confidence: 1,
        sourceRunId: null,
      });
      await store.activateFact(tenantId, proposal.id, "seed");
      changes[tenantId]++;
    }
  }
  return changes;
}
