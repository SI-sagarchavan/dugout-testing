// pnpm seed [agent...] — loads each agent's house facts (`data/<tenant>/style.json`) as active
// semantic memory for every tenant that has them. All agents unless some are named. Safe to re-run.
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { agentIds, loadAgent } from "../src/index.ts";

loadEnv();
const named = process.argv.slice(2);
const ids = named.length ? named : await agentIds();
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const tenants = loadTenants()
  .list()
  .map((t) => t.id);
try {
  for (const id of ids) {
    const agent = await loadAgent(id);
    for (const [tenant, changed] of Object.entries(await agent.seed(store, tenants))) {
      console.log(`${id} · ${tenant}: ${changed} facts updated`);
    }
  }
} finally {
  await pool.end();
}
