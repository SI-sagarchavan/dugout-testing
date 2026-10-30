// pnpm worker — runs agents (ADR 0009). It claims runs from Postgres (queued by a host, decided,
// or left by a worker that died), runs them, and writes their events to Valkey and Postgres. It has
// no port. AGENTS=sitemap,... limits it to some agents, so an agent can have workers of its own.

import { agent as matchPreview } from "@dugout/agent-match-preview";
import { agent as sitemap } from "@dugout/agent-sitemap";
import { liveDeps } from "@dugout/sdk";
import { Valkey } from "iovalkey";
import { createValkeyEventLog, createWorker, hostAgents, LOCAL_VALKEY_URL } from "../src/index.ts";

// every agent a worker can run, by id
const all = [matchPreview, sitemap];
const only = process.env.AGENTS?.split(",").map((id) => id.trim());
const unknown = only?.filter((id) => !all.some((a) => a.spec.id === id)) ?? [];
if (unknown.length) {
  console.error(`unknown agents in AGENTS: ${unknown.join(", ")}`);
  process.exit(1);
}
const served = only ? all.filter((a) => only.includes(a.spec.id)) : all;

const deps = liveDeps();
const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
const worker = createWorker({
  pool: deps.pool,
  events: createValkeyEventLog(valkey, { keyPrefix: process.env.VALKEY_KEY_PREFIX ?? "" }),
  agents: hostAgents(deps, ...served),
  concurrency: Number(process.env.WORKER_CONCURRENCY || 10),
  historyDays: Number(process.env.RUN_HISTORY_DAYS || 30),
  onError: (runId, err) => console.error(`run ${runId}:`, err),
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
  valkey.disconnect();
  await deps.pool.end();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
