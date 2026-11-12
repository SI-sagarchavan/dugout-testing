// pnpm agent memory builds --tenant sb [--section <signature>] [--agent <id>] [--forget <id>] —
// how sections were built (ADR 0034): each run's record of what it did on a section and how that
// turned out, newest first. A later run on the same section, or one like it, starts from these.
// --forget removes one (by its id or the start of it): it is not read again.
import { parseArgs } from "node:util";
import type { BuildRecord } from "@dugout/contracts";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "../src/index.ts";

loadEnv();
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    section: { type: "string" },
    agent: { type: "string" },
    forget: { type: "string" },
  },
});
if (!values.tenant) {
  console.error(
    "usage: pnpm agent memory builds --tenant <id> [--section <signature>] [--agent <id>] [--forget <id>]",
  );
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });

try {
  const all = await store.builds(tenant.id, {
    ...(values.section ? { sections: [values.section] } : {}),
    ...(values.agent ? { agentId: values.agent } : {}),
  });
  if (values.forget) {
    const hits = all.filter((b) => b.id.startsWith(values.forget ?? ""));
    if (hits.length !== 1) {
      console.error(`${hits.length} records start with ${values.forget}`);
      process.exitCode = 1;
    } else if (hits[0] && (await store.forgetEpisode(tenant.id, hits[0].id))) {
      console.log(`forgot ${hits[0].id}: ${hits[0].content}`);
    }
  } else {
    if (all.length === 0) console.log(`${tenant.id}: no build records`);
    for (const b of all) {
      const r = b.value as BuildRecord;
      const o = r.outcome;
      const name = r.section.name ? `"${r.section.name}" ` : "";
      console.log(`\n${b.id.slice(0, 8)}  ${r.agent}  ${name}${r.section.signature}`);
      console.log(`  ${b.content}`);
      console.log(
        `  ${o.good ? "good" : `not good (${o.ended})`}${o.score === undefined ? "" : `, match ${o.score}`}` +
          ` · ${o.steps} steps, $${o.costUsd.toFixed(3)}, ${o.asked} asked, approved by ${o.approvedBy}` +
          ` · ${b.strength} time${b.strength === 1 ? "" : "s"}, last ${b.lastSeenAt.slice(0, 10)}`,
      );
      for (const left of o.remaining.slice(0, 3)) console.log(`  left: ${left}`);
      for (const c of r.corrected ?? []) console.log(`  corrected by ${c.by}: ${c.what}`);
    }
  }
} finally {
  await pool.end();
}
