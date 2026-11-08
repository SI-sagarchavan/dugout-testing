// pnpm worker — runs agents (ADR 0009). It claims runs from Postgres (queued by a host, decided,
// or left by a worker that died), runs them, and writes their events to Valkey and Postgres. It has
// no port. AGENTS=sitemap,... limits it to some agents, so an agent can have workers of its own.
// After each completed preview or binding run it puts the Handoff's sections in the section
// library and shares them (`.scratch/section-library/`); LIBRARY=off leaves that out, and
// LIBRARY_CAPTION_MODEL=off adds sections without a vision model's caption (haiku unless named).

import { join } from "node:path";
import { agent as bind } from "@dugout/agent-data-bind";
import { agent as frameMatch } from "@dugout/agent-frame-match";
import { agent as hookMaker } from "@dugout/agent-hook-maker";
import { agent as sectionBuilder } from "@dugout/agent-section-builder";
import { agent as sitemap } from "@dugout/agent-sitemap";
import { agent as uiEditor } from "@dugout/agent-ui-editor";
import { REPO_ROOT } from "@dugout/core";
import {
  createFileCropStore,
  createHashMultimodalEmbeddings,
  createSectionLibrary,
  createVisionCaptioner,
  type FanosTools,
  libraryFollowUp,
  loadFanosTools,
  surfaceConfig,
} from "@dugout/library";
import { liveDeps } from "@dugout/sdk";
import { Valkey } from "iovalkey";
import { createValkeyEventLog, createWorker, hostAgents, LOCAL_VALKEY_URL } from "../src/index.ts";

// every agent a worker can run, by id. hook-maker also runs inside bind, and
// frame-match and bind inside section-builder, as children: a worker that serves the parent runs them
// there whether or not it serves them on their own
const all = [sitemap, frameMatch, bind, hookMaker, sectionBuilder, uiEditor];
const only = process.env.AGENTS?.split(",").map((id) => id.trim());
const unknown = only?.filter((id) => !all.some((a) => a.spec.id === id)) ?? [];
if (unknown.length) {
  console.error(`unknown agents in AGENTS: ${unknown.join(", ")}`);
  process.exit(1);
}
const served = only ? all.filter((a) => only.includes(a.spec.id)) : all;

const deps = liveDeps();

/** The section library's step after a run, unless LIBRARY=off. */
const library = (() => {
  if (process.env.LIBRARY === "off") return undefined;
  let tools: Promise<FanosTools> | undefined;
  const captionModel = process.env.LIBRARY_CAPTION_MODEL ?? "haiku";
  const follow = libraryFollowUp({
    pool: deps.pool,
    library: createSectionLibrary({
      pool: deps.pool,
      embeddings: createHashMultimodalEmbeddings(),
    }),
    crops: createFileCropStore(
      process.env.LIBRARY_CROPS_DIR ?? join(REPO_ROOT, ".runs", "library"),
    ),
    tools: () => {
      tools ??= loadFanosTools();
      return tools;
    },
    ...(captionModel !== "off"
      ? { captioner: createVisionCaptioner({ model: captionModel }) }
      : {}),
    surface: surfaceConfig(),
    memory: deps.store,
  });
  return async (run: { tenantId: string; runId: string; agentId: string }) => {
    const result = await follow(run);
    if (!result) return;
    const added = result.indexed.reduce((n, r) => n + r.added.length, 0);
    const marked = result.marked.reduce((n, m) => n + m.sections, 0);
    const shaped = result.shaped.reduce((n, m) => n + m.sections, 0);
    if (added || marked || shaped) {
      console.log(
        `library: run ${run.runId} (${run.tenantId}): ${added} sections added, ${marked} shared, ${shaped} given their data shape`,
      );
    }
    if (result.paletteProposed) {
      console.log(
        `library: proposed ${run.tenantId}'s skeleton palette from its designs; approve it with pnpm agent memory review --tenant ${run.tenantId}`,
      );
    }
    for (const f of result.failed) {
      console.error(`library: run ${f.runId}, Handoff ${f.handoffId}: ${f.error}`);
    }
  };
})();

const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
const worker = createWorker({
  pool: deps.pool,
  events: createValkeyEventLog(valkey, { keyPrefix: process.env.VALKEY_KEY_PREFIX ?? "" }),
  agents: hostAgents(deps, ...served),
  concurrency: Number(process.env.WORKER_CONCURRENCY || 10),
  historyDays: Number(process.env.RUN_HISTORY_DAYS || 30),
  onError: (runId, err) => console.error(`run ${runId}:`, err),
  ...(library ? { onCompleted: library } : {}),
});
worker.start(Number(process.env.WORKER_POLL_MS || 1_000));
console.log(
  `dugout worker ${worker.owner}: waiting for runs of ${served.map((a) => a.spec.id).join(", ")}` +
    (deps.tracing ? " (tracing to Langfuse)" : ""),
);

// ECS sends SIGTERM, then SIGKILL after its stop timeout (30 s by default): runs get 20 s to end or
// wait, and the rest are handed to another worker, which resumes them from their last save.
const shutdown = async () => {
  await worker.stop(Number(process.env.WORKER_GRACE_MS || 20_000));
  await deps.tracing?.shutdown();
  await deps.mcp.close();
  valkey.disconnect();
  await deps.pool.end();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
