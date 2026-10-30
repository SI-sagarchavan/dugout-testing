// pnpm memory:review --tenant demo-cricket — approve or reject proposed facts, tenant-wide or an
// agent's own.
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "../src/index.ts";

loadEnv();
const { values } = parseArgs({ options: { tenant: { type: "string" } } });
if (!values.tenant) {
  console.error("usage: pnpm memory:review --tenant <id>");
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const reviewer = userInfo().username;
const rl = createInterface({ input: process.stdin, output: process.stdout });

const proposals = await store.listProposals(tenant.id);
if (proposals.length === 0) console.log(`${tenant.id}: nothing to review`);
for (const p of proposals) {
  // what runs of this scope read today: for an agent's proposal, possibly the tenant-wide fact
  const current = (await store.activeFacts(tenant.id, p.agentId)).find((f) => f.key === p.key);
  const scope = (agentId: string | null) => agentId ?? "tenant";
  console.log(
    `\n[${scope(p.agentId)}] ${p.key} (confidence ${p.confidence}, from run ${p.sourceRunId})`,
  );
  if (current) console.log(`  now:      ${current.content} [${scope(current.agentId)}]`);
  console.log(`  proposed: ${p.content}`);
  const answer = (await rl.question("  (a)pprove, (r)eject, (s)kip? ")).trim().toLowerCase();
  if (answer === "a") await store.activateFact(tenant.id, p.id, reviewer);
  else if (answer === "r") await store.rejectProposal(tenant.id, p.id, reviewer);
}
rl.close();
await pool.end();
