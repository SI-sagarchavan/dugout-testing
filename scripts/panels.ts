// pnpm tsx scripts/panels.ts <out.json> — writes the property panel of every node type, from the
// DSL's field descriptors (`panelOf`), for a front end that cannot import @fanos/dsl. Surface
// Studio (wnm-fanxp-frontend) keeps the result as `features/queue/lib/panels.generated.json`;
// run this again, and commit the diff there, when the vocabulary changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NODE_TYPES, panelOf } from "../packages/dsl/dist/index.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: tsx scripts/panels.ts <out.json>");
  process.exit(1);
}
const panels = Object.fromEntries([...NODE_TYPES].sort().map((type) => [type, panelOf(type)]));
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, `${JSON.stringify(panels, null, 2)}\n`);
console.log(`wrote ${Object.keys(panels).length} node types to ${out}`);
