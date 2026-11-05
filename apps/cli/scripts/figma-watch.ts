// pnpm agent watch --tenant demo-cricket [--project default] [--latest] [--model sonnet] [--effort high] [--ask]
//
// Press Handoff in the Figma plugin and one section-builder run starts: the frame is matched to its
// screenshot and published (frame-match), then its data is found in Cast, or a hook is built there,
// and bound (bind), and one preview is handed over. It publishes without asking; --ask brings the
// approval prompt back (one for the whole pass). This host looks at the control plane
// for new exports, queues a run for each, follows it here and asks at its approval. The plugin and
// the pipeline are unchanged. Needs `pnpm worker`. --latest also runs on the newest export sent
// before now. Ctrl-C stops watching; a run in progress goes on in its worker.

import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { controlPlaneUrl, createControlPlane, RunInput } from "@dugout/agent-frame-match";
import { agent } from "@dugout/agent-section-builder";
import { loadEnv, loadModelConfig, REPO_ROOT, runModel } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createRunQueue, createValkeyEventLog, LOCAL_VALKEY_URL } from "@dugout/worker";
import { Valkey } from "iovalkey";
import { recordCompilerFindings } from "../src/compiler-findings.ts";
import { createFigmaWatch, FIGMA_AGENT, finishedLines, PRIOR_AGENTS } from "../src/figma-watch.ts";
import type { Terminal } from "../src/session.ts";
import { followRun } from "../src/session.ts";

const POLL_MS = 2_000;

loadEnv();
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    project: { type: "string", default: "default" },
    latest: { type: "boolean", default: false },
    model: { type: "string" },
    effort: { type: "string" },
    ask: { type: "boolean", default: false },
  },
});
if (!values.tenant) {
  console.error(
    "usage: pnpm agent watch --tenant <tenant> [--project <id>] [--latest] [--model <name>] [--effort <level>] [--ask]",
  );
  process.exit(1);
}
const tenantId = values.tenant;
let model: string | undefined;
try {
  model = runModel(loadModelConfig(), agent.spec.model, values);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const project = values.project as string;

const plane = createControlPlane(project);
const pool = createPool();
const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
const queue = createRunQueue({
  pool,
  events: createValkeyEventLog(valkey, { keyPrefix: process.env.VALKEY_KEY_PREFIX ?? "" }),
});

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const terminal: Terminal = {
  write: (text) => void process.stdout.write(text),
  line: (text) => console.log(text),
  async ask(prompt) {
    process.stdout.write(prompt);
    const next = await lines.next();
    return next.done ? "" : String(next.value).trim();
  },
};

let since = new Date();
if (values.latest) {
  const [newest] = await plane.listExports(1);
  if (newest?.receivedAt) since = new Date(Date.parse(newest.receivedAt) - 1);
}
const watch = createFigmaWatch({
  project,
  since,
  listExports: (limit) => plane.listExports(limit),
  priorRuns: async () =>
    (await queue.matching(tenantId, "", 200)).filter((run) => PRIOR_AGENTS.includes(run.agent_id)),
  start: (input) => {
    RunInput.parse(input);
    return queue.start(tenantId, FIGMA_AGENT, input, { ...(model ? { model } : {}) });
  },
});

const stop = new AbortController();
process.once("SIGINT", () => {
  stop.abort();
  console.log("\nstopped watching; a run in progress goes on in its worker");
});

console.log(
  `watching ${controlPlaneUrl()} (project ${project}) for Handoff, as ${tenantId}, on ${model ?? agent.spec.model}${values.ask ? "" : ", publishing without asking"}`,
);
let unreachable = false;
while (!stop.signal.aborted) {
  try {
    for (const { runId, rootName } of await watch.look()) {
      console.log(`\nSend received: ${rootName}\nrun ${runId}`);
      console.log(`attach elsewhere: pnpm agent attach --run ${runId} --tenant ${tenantId}`);
      const ending = await followRun({
        queue,
        agent,
        tenantId,
        runId,
        terminal,
        by: userInfo().username,
        signal: stop.signal,
        autoApprove: !values.ask,
      });
      if (stop.signal.aborted) break;
      if (ending) for (const line of finishedLines(ending, runId)) console.log(line);
      const findings = (ending?.data as { output?: { compilerFindings?: string[] } } | undefined)
        ?.output?.compilerFindings;
      if (findings?.length) {
        const { created, repeated } = recordCompilerFindings(REPO_ROOT, findings, { runId });
        console.log(
          `  compiler findings filed: ${created.length} new, ${repeated.length} already on file (.scratch/compiler-findings/)`,
        );
      }
    }
    unreachable = false;
  } catch (err) {
    // the control plane restarting is no reason to stop watching; say so once
    if (!unreachable) console.error(`can't look for exports yet: ${(err as Error).message}`);
    unreachable = true;
  }
  await new Promise((done) => setTimeout(done, POLL_MS));
}
await lines.return?.();
valkey.disconnect();
await pool.end();
process.exit(0);
