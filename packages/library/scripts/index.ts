// pnpm agent library index --tenant demo-cricket (--handoff <id> | --latest <n> | --all) [--project default]
//   [--model haiku] [--no-caption]
// Reads each Handoff's IR and pictures from the control plane (`pnpm dev`), finds its sections,
// and adds them to the tenant's section library: cut, summarised, captioned by a vision model,
// embedded. A section already there gets one more source. Pictures go to .runs/library/.
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import {
  createControlPlaneSource,
  createVisionCaptioner,
  indexHandoff,
  loadFanosTools,
} from "../src/index.ts";
import { openLibrary } from "./common.ts";

loadEnv();
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    project: { type: "string", default: "default" },
    handoff: { type: "string" },
    latest: { type: "string" },
    all: { type: "boolean" },
    model: { type: "string", default: "haiku" },
    "no-caption": { type: "boolean" },
  },
});
if (!values.tenant || [values.handoff, values.latest, values.all].filter(Boolean).length !== 1) {
  console.error(
    "usage: pnpm agent library index --tenant <id> (--handoff <id> | --latest <n> | --all) [--project default] [--model haiku] [--no-caption]",
  );
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const source = createControlPlaneSource(values.project);
const ids = values.handoff
  ? [values.handoff]
  : (await source.listExports(values.all ? 1000 : Number(values.latest))).map((e) => e.id);

const { pool, library, crops, cropDir } = openLibrary();
const tools = await loadFanosTools();
const captioner = values["no-caption"] ? undefined : createVisionCaptioner({ model: values.model });

console.log(
  `${tenant.id}: indexing ${ids.length} Handoff${ids.length === 1 ? "" : "s"} from ${values.project}` +
    `${captioner ? `, captioned by ${captioner.model}` : ", without captions"}; pictures in ${cropDir}`,
);
const totals = { added: 0, seen: 0, skipped: 0, failed: 0, handoffsFailed: 0 };
for (const [i, id] of ids.entries()) {
  const started = Date.now();
  try {
    const r = await indexHandoff({
      tenantId: tenant.id,
      handoffId: id,
      source,
      library,
      crops,
      tools,
      ...(captioner ? { captioner } : {}),
    });
    totals.added += r.added.length;
    totals.seen += r.seen.length;
    totals.skipped += r.skipped.length;
    totals.failed += r.failed.length;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `\n[${i + 1}/${ids.length}] ${r.rootName} (${id}) ${secs}s: ${r.added.length} added, ${r.seen.length} seen before, ${r.skipped.length} left out`,
    );
    for (const s of r.added) {
      console.log(
        `  + ${"  ".repeat(s.level)}${s.name} [${s.kind}${s.layout !== "none" ? `, ${s.layout}` : ""}]${s.captioned ? "" : " (no caption)"}`,
      );
    }
    for (const s of r.seen) console.log(`  = ${"  ".repeat(s.level)}${s.name}`);
    for (const s of r.skipped) console.log(`  - ${s.name}: ${s.reason}`);
    for (const f of r.failed) console.log(`  ! ${f.name}: ${f.error}`);
  } catch (err) {
    totals.handoffsFailed++;
    console.log(`\n[${i + 1}/${ids.length}] ${id}: ${(err as Error).message}`);
  }
}
console.log(
  `\n${totals.added} sections added, ${totals.seen} seen before, ${totals.skipped} left out, ${totals.failed} problems` +
    `${totals.handoffsFailed ? `, ${totals.handoffsFailed} Handoffs not read` : ""}`,
);
await pool.end();
