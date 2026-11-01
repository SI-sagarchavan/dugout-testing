// pnpm db seed — loads each tenant's house facts (`config/tenants/<tenant>/facts.json`) as its active
// semantic memory. Every agent of the tenant reads them. Safe to re-run.
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { seedHouseFacts } from "../src/index.ts";

loadEnv();
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const tenants = loadTenants()
  .list()
  .map((t) => t.id);
try {
  for (const { tenantId, changed } of await seedHouseFacts(store, tenants)) {
    console.log(`${tenantId}: ${changed} facts updated`);
  }
} finally {
  await pool.end();
}
