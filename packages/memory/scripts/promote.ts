// pnpm memory:promote [--min-tenants 2] — finds the same fact, or the same lesson of one agent, in
// several tenants and proposes it as shared memory: for their sport, or for every tenant when they
// span sports (ADR 0014). The smart model rewrites each without naming any tenant; a person approves
// each with `pnpm memory:review --shared`. Runs as the admin role, since it reads across tenants.
import { parseArgs } from "node:util";
import { createBedrockClient, loadEnv, loadTenants } from "@dugout/core";
import { adminDatabaseUrl, createPool } from "@dugout/db";
import {
  createModelGeneralizer,
  createSharedMemory,
  loadEmbeddings,
  promoteSharedMemory,
} from "../src/index.ts";

loadEnv();
const { values } = parseArgs({ options: { "min-tenants": { type: "string" } } });
const pool = createPool(adminDatabaseUrl());
// Nova Lite failed to tell a club's own facts from a shared instruction in tests on 2026-10-30;
// Claude Sonnet 5 told them apart every time, and its India profile keeps tenant data in India
const model = process.env.MEMORY_PROMOTE_MODEL || "sonnet-india";
try {
  const { proposed, skipped } = await promoteSharedMemory({
    shared: createSharedMemory({ pool, embeddings: loadEmbeddings() }),
    generalize: createModelGeneralizer(createBedrockClient(), model),
    tenants: loadTenants().list(),
    ...(values["min-tenants"] ? { minTenants: Number(values["min-tenants"]) } : {}),
  });
  for (const p of proposed) {
    const what = p.kind === "semantic" ? `fact ${p.key}` : "lesson";
    console.log(`proposed [${p.sharedScope}] ${what}: ${p.content} (from ${p.strength} tenants)`);
  }
  console.log(
    `${proposed.length} proposed, ${skipped} kept as tenant-specific. Review with: pnpm memory:review --shared`,
  );
} finally {
  await pool.end();
}
