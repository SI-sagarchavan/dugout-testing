// pnpm agent library reembed [--tenant <id>] [--check] — embeds again every section that another
// embedder made (its words and its picture). Run it once after EMBEDDING_PROVIDER changes (the hash
// embedder to Nova Multimodal Embeddings): until then a search compares vectors that cannot be
// compared. Every tenant's sections, so it runs as the admin role. --check counts them and exits 1
// when there are any.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, REPO_ROOT } from "@dugout/core";
import { adminDatabaseUrl, createPool } from "@dugout/db";
import {
  createFileCropStore,
  loadMultimodalEmbeddings,
  reembedSections,
  staleSections,
} from "../src/index.ts";

loadEnv();
const { values } = parseArgs({
  options: { check: { type: "boolean", default: false }, tenant: { type: "string" } },
});
const pool = createPool(adminDatabaseUrl());
const embeddings = loadMultimodalEmbeddings();
const crops = createFileCropStore(
  process.env.LIBRARY_CROPS_DIR ?? join(REPO_ROOT, ".runs", "library"),
);
try {
  const stale = await staleSections(pool, embeddings.model, values.tenant);
  const total = Object.values(stale).reduce((a, b) => a + b, 0);
  const from = Object.entries(stale)
    .map(([model, n]) => `${n} from ${model}`)
    .join(", ");
  if (total === 0) {
    console.log(`every section is embedded with ${embeddings.model}`);
  } else if (values.check) {
    console.log(`${total} sections are not embedded with ${embeddings.model}: ${from}`);
    process.exitCode = 1;
  } else {
    console.log(`embedding ${total} sections again with ${embeddings.model} (${from})`);
    const { done, missing } = await reembedSections({
      pool,
      embeddings,
      crops,
      ...(values.tenant ? { tenantId: values.tenant } : {}),
      onBatch: (n) => process.stdout.write(`\r${n}/${total}`),
    });
    console.log(`\n${done} sections embedded with ${embeddings.model}`);
    if (missing.length) {
      console.log(`${missing.length} left as they were, their picture is not in the store`);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
