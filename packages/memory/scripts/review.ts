// pnpm agent memory review --tenant demo-cricket — approve or reject the tenant's proposed facts. Every
// agent of the tenant reads an approved fact.
// pnpm agent memory review --shared — approve or reject proposed shared memory (ADR 0014), shown beside
// the tenant items it was promoted from. Check it names no tenant before approving: every tenant
// of its scope will read it. Runs as the admin role, the only one that writes shared memory.
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { adminDatabaseUrl, createPool } from "@dugout/db";
import { createMemoryStore, createSharedMemory, groupLabel, loadEmbeddings } from "../src/index.ts";

loadEnv();
const { values } = parseArgs({
  options: { tenant: { type: "string" }, shared: { type: "boolean" } },
});
if (!values.tenant && !values.shared) {
  console.error("usage: pnpm agent memory review --tenant <id> | --shared");
  process.exit(2);
}
const reviewer = userInfo().username;
const rl = createInterface({ input: process.stdin, output: process.stdout });
// input that ends (a closed pipe, Ctrl-D) stops the review instead of crashing it
const ask = async () => {
  try {
    return (await rl.question("  (a)pprove, (r)eject, (s)kip, (q)uit? ")).trim().toLowerCase();
  } catch {
    return "q";
  }
};

if (values.shared) {
  const pool = createPool(adminDatabaseUrl());
  const shared = createSharedMemory({ pool, embeddings: loadEmbeddings() });
  const proposals = await shared.proposals();
  if (proposals.length === 0) console.log("shared memory: nothing to review");
  for (const p of proposals) {
    const what = p.kind === "semantic" ? `fact ${p.key}` : `lesson for ${p.agentId}`;
    console.log(`\n[${p.sharedScope}] ${what}, from ${p.strength} tenants`);
    console.log(`  ${groupLabel(p.sharedScope ?? "global")} will read it`);
    for (const source of await shared.items(p.sources)) {
      console.log(`  ${source.tenantId}: ${source.content}`);
    }
    console.log(`  proposed: ${p.content}`);
    const answer = await ask();
    if (answer === "q") break;
    if (answer === "a") await shared.activate(p.id, reviewer);
    else if (answer === "r") await shared.reject(p.id, reviewer);
  }
  await pool.end();
} else {
  const tenant = loadTenants().require(values.tenant ?? "");
  const pool = createPool();
  const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
  const proposals = await store.listProposals(tenant.id);
  if (proposals.length === 0) console.log(`${tenant.id}: nothing to review`);
  for (const p of proposals) {
    const current = (await store.activeFacts(tenant.id)).find((f) => f.key === p.key);
    console.log(
      `\n${p.key} (proposed by ${p.agentId ?? "seed"}, confidence ${p.confidence}, from run ${p.sourceRunId})`,
    );
    console.log("  every agent of this tenant will read it");
    if (current) console.log(`  now:      ${current.content}`);
    console.log(`  proposed: ${p.content}`);
    const answer = await ask();
    if (answer === "q") break;
    if (answer === "a") await store.activateFact(tenant.id, p.id, reviewer);
    else if (answer === "r") await store.rejectProposal(tenant.id, p.id, reviewer);
  }
  await pool.end();
}
rl.close();
