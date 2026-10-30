// pnpm seed [agent...] — loads each tenant's house facts (`config/tenants/<tenant>/facts.json`) as
// active semantic memory: the shared ones, and each agent's own for every agent unless some are
// named. Safe to re-run.
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { agentIds, loadAgent, seedHouseFacts } from "../src/index.ts";

loadEnv();
const named = process.argv.slice(2);
// throws on a name that isn't an agent, rather than seeding nothing
for (const id of named) await loadAgent(id);
const ids = named.length ? named : await agentIds();
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const tenants = loadTenants()
  .list()
  .map((t) => t.id);
try {
  for (const { tenantId, agentId, changed } of await seedHouseFacts(store, tenants, ids)) {
    console.log(`${agentId ?? "shared"} · ${tenantId}: ${changed} facts updated`);
  }
} finally {
  await pool.end();
}
