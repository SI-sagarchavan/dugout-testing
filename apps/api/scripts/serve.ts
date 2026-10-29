// pnpm api — HTTP/SSE API on :8787 (PORT), running agents in this process. Runs keep their working
// memory in Postgres (ADR 0006): a decision resumes a waiting run, and runs whose process died are
// picked up again by the recovery sweep.

import { agent as matchPreview } from "@dugout/agent-match-preview";
import { agent as sitemap } from "@dugout/agent-sitemap";
import { loadTenants } from "@dugout/core";
import { liveDeps } from "@dugout/sdk";
import { serve } from "@hono/node-server";
import { Valkey } from "iovalkey";
import {
  createApp,
  createRunManager,
  createValkeyEventLog,
  hostAgents,
  LOCAL_DEV_SECRET,
  LOCAL_VALKEY_URL,
} from "../src/index.ts";

const deps = liveDeps();
const secret = process.env.DUGOUT_JWT_SECRET || LOCAL_DEV_SECRET;
const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
const events = createValkeyEventLog(valkey);
const runs = createRunManager({
  pool: deps.pool,
  events,
  // the agents this API serves, by id (POST /runs { agentId })
  agents: hostAgents(deps, matchPreview, sitemap),
  onError: (runId, err) => console.error(`run ${runId} crashed:`, err),
});
const app = createApp({ pool: deps.pool, runs, events, tenants: loadTenants(), secret });
runs.startRecovery();

const port = Number(process.env.PORT || 8787);
const server = serve({ fetch: app.fetch, port }, () =>
  console.log(
    `dugout api on http://localhost:${port} as ${runs.owner}${deps.tracing ? " (tracing to Langfuse)" : ""}`,
  ),
);

// Stop taking requests and let runs in flight save and finish. A run still going when the process
// exits keeps its lease until it runs out, then another process picks it up.
const shutdown = async () => {
  runs.stop();
  server.close();
  await runs.idle();
  await deps.tracing?.shutdown();
  await deps.pool.end();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
