// pnpm preview --tenant demo-cricket --fixture c-101 [--brief "..."] [--fast]
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { RunEvent } from "@dugout/contracts";
import { type Approver, loadTenants } from "@dugout/core";
import { createMatchPreview, draftOf, liveDeps } from "../src/index.ts";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    fixture: { type: "string" },
    brief: { type: "string" },
    fast: { type: "boolean", default: false },
  },
});
if (!values.tenant || !values.fixture) {
  console.error("usage: pnpm preview --tenant <id> --fixture <id> [--brief text] [--fast]");
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const deps = liveDeps({ fast: values.fast });
const run = createMatchPreview(deps);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const approver: Approver = async (req) => {
  const draft = draftOf(req);
  console.log(`\n\n── Draft for ${draft.fixtureId} (${words(draft.body)} words) ──`);
  console.log(`${draft.title}\n\n${draft.body}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Approve and save? [y/N] ")).trim().toLowerCase();
    const by = userInfo().username;
    if (answer === "y" || answer === "yes") return { approved: true, by };
    const reason = (await rl.question("Reason for rejecting: ")).trim() || "no reason given";
    return { approved: false, by, reason };
  } finally {
    rl.close();
  }
};

const show = (e: RunEvent) => {
  if (e.type === "token") process.stdout.write(e.data.text);
  else if (e.type === "context.built")
    console.log(
      dim(
        `· memory: ${e.data.sources.map((s) => s.kind).join(", ") || "none"} (${e.data.tokens} tokens)`,
      ),
    );
  else if (e.type === "tool.started")
    console.log(dim(`· ${e.data.tool} ${JSON.stringify(e.data.input)}`));
  else if (e.type === "tool.denied") console.log(dim(`· denied ${e.data.tool}: ${e.data.reason}`));
  else if (e.type === "tool.completed" && !e.data.ok)
    console.log(dim(`· ${e.data.tool} failed: ${e.data.content}`));
};

const result = await run({
  tenantId: tenant.id,
  input: { fixtureId: values.fixture, ...(values.brief ? { brief: values.brief } : {}) },
  approver,
  sinks: [{ write: show }, ...(deps.tracing ? [deps.tracing.sink()] : [])],
});

console.log(
  `\n${result.status}${result.status === "failed" ? ` (${result.reason}: ${result.message})` : ""}`,
);
console.log(
  dim(
    `cost $${result.usage.costUsd.toFixed(4)} · ${result.usage.steps} steps · .runs/${result.runId}/events.jsonl`,
  ),
);
if (result.status === "rejected")
  console.log(dim("· rejection saved to this tenant's memory as a lesson"));
if (result.afterRunError) console.error(`memory consolidation failed: ${result.afterRunError}`);
await deps.tracing?.shutdown();
await deps.pool.end();
