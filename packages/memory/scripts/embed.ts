// pnpm agent memory embed [--tenant <id>] [--check] — embeds again every memory row that another embedder made
// (ADR 0034). Run it once after the embedder changes (EMBEDDING_PROVIDER, EMBEDDING_MODEL): until
// then search and lesson recall compare vectors that cannot be compared. Every tenant's rows and
// the shared ones, so it runs as the admin role. --check counts them and exits 1 when there are any.
import { parseArgs } from "node:util";
import { loadEnv } from "@dugout/core";
import { adminDatabaseUrl, createPool } from "@dugout/db";
import { loadEmbeddings, reembed, staleEmbeddings } from "../src/index.ts";

loadEnv();
const { values } = parseArgs({
  options: { check: { type: "boolean", default: false }, tenant: { type: "string" } },
});
const pool = createPool(adminDatabaseUrl());
const embeddings = loadEmbeddings();
try {
  const stale = await staleEmbeddings(pool, embeddings.model, values.tenant);
  const total = Object.values(stale).reduce((a, b) => a + b, 0);
  const from = Object.entries(stale)
    .map(([model, n]) => `${n} from ${model}`)
    .join(", ");
  if (total === 0) {
    console.log(`every row is embedded with ${embeddings.model}`);
  } else if (values.check) {
    console.log(`${total} rows are not embedded with ${embeddings.model}: ${from}`);
    process.exitCode = 1;
  } else {
    console.log(`embedding ${total} rows again with ${embeddings.model} (${from})`);
    const done = await reembed({
      pool,
      embeddings,
      ...(values.tenant ? { tenantId: values.tenant } : {}),
      onBatch: (n) => process.stdout.write(`\r${n}/${total}`),
    });
    console.log(`\n${done} rows embedded with ${embeddings.model}`);
  }
} finally {
  await pool.end();
}
