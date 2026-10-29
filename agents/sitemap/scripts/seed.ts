// Loads each demo tenant's sitemap house facts as active semantic memory. Safe to re-run.
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
for (const [tenant, changed] of Object.entries(await seedHouseFacts(store, tenants))) {
  console.log(`${tenant}: ${changed} facts updated`);
}
await pool.end();
