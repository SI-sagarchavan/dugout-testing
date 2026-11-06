// pnpm agent library previews --tenant sb [--model haiku] [--no-caption] [--reindex]
// Every preview the tenant's frame-match and section-builder runs built puts the sections of its
// Handoff in the shared pool. A Handoff the library has not seen is indexed first: from the FanXP
// backend for a `handoffId` (SURFACE_API_URL, SURFACE_SERVICE_KEY), from the control plane for an
// `exportId`. Safe to run again. --reindex reads every previewed Handoff again (new skeletons).
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import {
  createControlPlaneSource,
  createSurfaceHandoffSource,
  createVisionCaptioner,
  indexHandoff,
  loadFanosTools,
  surfaceConfig,
  syncPreviews,
} from "../src/index.ts";
import { openLibrary } from "./common.ts";

loadEnv();
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    model: { type: "string", default: "haiku" },
    "no-caption": { type: "boolean" },
    reindex: { type: "boolean" },
  },
});
if (!values.tenant) {
  console.error(
    "usage: pnpm agent library previews --tenant <id> [--model haiku] [--no-caption] [--reindex]",
  );
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const { pool, library, crops } = openLibrary();
const tools = await loadFanosTools();
const captioner = values["no-caption"] ? undefined : createVisionCaptioner({ model: values.model });
const surface = surfaceConfig();

const result = await syncPreviews({
  pool,
  tenantId: tenant.id,
  library,
  ...(values.reindex ? { reindex: true } : {}),
  index: async (run) => {
    let source: Parameters<typeof indexHandoff>[0]["source"];
    if (run.handoff.kind === "handoff") {
      if (!surface)
        throw new Error("set SURFACE_API_URL and SURFACE_SERVICE_KEY to read FanXP Handoffs");
      source = createSurfaceHandoffSource(tenant.id, run.handoff.id, surface);
    } else {
      source = createControlPlaneSource(run.handoff.project);
    }
    console.log(`indexing ${run.handoff.kind} ${run.handoff.id}, previewed by run ${run.runId}`);
    return indexHandoff({
      tenantId: tenant.id,
      handoffId: run.handoff.id,
      source,
      library,
      crops,
      tools,
      ...(captioner ? { captioner } : {}),
    });
  },
});

for (const r of result.indexed) {
  console.log(
    `  ${r.rootName}: ${r.added.length} added, ${r.seen.length} seen before, ${r.skipped.length} left out`,
  );
  for (const s of r.skipped) console.log(`    - ${s.name}: ${s.reason}`);
  for (const f of r.failed) console.log(`    ! ${f.name}: ${f.error}`);
}
const newly = result.marked.filter((m) => m.sections > 0);
for (const m of newly)
  console.log(`run ${m.runId}: ${m.sections} sections of ${m.handoffId} previewed`);
for (const f of result.failed) console.log(`run ${f.runId} (${f.handoffId}): ${f.error}`);
console.log(
  `\n${tenant.id}: ${result.runs} preview runs, ${result.indexed.length} Handoffs indexed, ${newly.length} newly counted, ${result.failed.length} failed`,
);
await pool.end();
