// pnpm schemas — writes each agent's input and output JSON Schema to schemas/, for hosts to check
// requests against before queueing a run (ADR 0009). An SDK test fails when they are out of date.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMAS_DIR, schemaFiles } from "../src/index.ts";

const files = await schemaFiles();
await mkdir(SCHEMAS_DIR, { recursive: true });
// an agent that is gone leaves no stale file behind
for (const name of await readdir(SCHEMAS_DIR)) {
  if (name.endsWith(".json") && !(name in files)) await rm(join(SCHEMAS_DIR, name));
}
for (const [name, content] of Object.entries(files)) {
  await writeFile(join(SCHEMAS_DIR, name), content);
}
console.log(`wrote ${Object.keys(files).length} files to schemas/`);
