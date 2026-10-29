// pnpm sitemap --tenant demo-cricket --brief "..." [--sport cricket] [--fast]
//
// At the approval prompt: y to save, n to reject, `path /fan-zone /fanzone` to change a page's url,
// `change: <what to change>` to ask the agent for any other change.
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { RunEvent } from "@dugout/contracts";
import { type Approver, loadTenants } from "@dugout/core";
import {
  createSitemap,
  EDIT_REQUEST_PREFIX,
  type Input,
  liveDeps,
  type NavItem,
  type PageNode,
  parseReply,
  type Reply,
  renamePath,
  SITEMAPS_DIR,
  type Sitemap,
  sitemapOf,
  writeSitemap,
} from "../src/index.ts";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    brief: { type: "string" },
    sport: { type: "string", multiple: true },
    fast: { type: "boolean", default: false },
  },
});
if (!values.tenant || !values.brief) {
  console.error('usage: pnpm sitemap --tenant <id> --brief "text" [--sport name]... [--fast]');
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const deps = liveDeps({ fast: values.fast });
const run = createSitemap(deps);
const by = userInfo().username;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const printPages = (nodes: PageNode[], indent = "") => {
  for (const node of nodes) {
    const url = node.dynamic ? "$*" : `/${node.slug ?? ""}`;
    console.log(`${indent}${node.name}  ${dim(url)}`);
    if (node.children) printPages(node.children, `${indent}  `);
  }
};
const printMenu = (items: NavItem[], indent = "") => {
  for (const item of items) {
    console.log(`${indent}${item.name}  ${dim(item.url)}`);
    if (item.children) printMenu(item.children, `${indent}  `);
  }
};

type Review =
  | Exclude<Reply, { kind: "unknown" } | { kind: "reject" }>
  | { kind: "reject"; reason: string };

// one reader for the whole session, so lines typed (or piped) ahead of a prompt are not lost
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const ask = async (prompt: string) => {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  if (done) process.stdout.write("\n");
  return done ? "" : String(value);
};

/** Shows the sitemap and asks until the editor gives an answer it understands. */
async function review(sitemap: Sitemap): Promise<Review> {
  console.log("\n\n── Pages ──");
  printPages(sitemap.pages);
  console.log("\n── Header menu ──");
  printMenu(sitemap.navigation);
  for (;;) {
    const answer = await ask(
      `\n${dim("y save · n reject · path /old /new · change: <what to change>")}\nYour answer: `,
    );
    const reply = parseReply(answer);
    if (reply.kind === "reject") {
      const reason = (await ask("Reason for rejecting: ")).trim() || "no reason given";
      return { kind: "reject", reason };
    }
    if (reply.kind !== "unknown") return reply;
    console.log("Say y, n, `path /old /new` or `change: ...`.");
  }
}

/** A change the editor asked for; the run that was showing the sitemap ends so it can be applied. */
let asked: Extract<Review, { kind: "path" | "change" }> | undefined;

const approver: Approver = async (req) => {
  const reply = await review(sitemapOf(req));
  if (reply.kind === "approve") return { approved: true, by };
  if (reply.kind === "reject") return { approved: false, by, reason: reply.reason };
  asked = reply;
  return {
    approved: false,
    by,
    reason: `${EDIT_REQUEST_PREFIX}${reply.kind === "path" ? `path ${reply.from} ${reply.to}` : reply.request}`,
  };
};

const show = (e: RunEvent) => {
  if (e.type === "token") process.stdout.write(e.data.text);
  else if (e.type === "context.built")
    console.log(
      dim(
        `· memory: ${e.data.sources.map((s) => s.kind).join(", ") || "none"} (${e.data.tokens} tokens)`,
      ),
    );
  else if (e.type === "tool.started") console.log(dim(`· ${e.data.tool}`));
  else if (e.type === "tool.denied") console.log(dim(`· denied ${e.data.tool}: ${e.data.reason}`));
  else if (e.type === "tool.completed" && !e.data.ok)
    console.log(dim(`· ${e.data.tool} failed: ${e.data.content}`));
};

const base: Input = {
  brief: values.brief,
  ...(values.sport?.length ? { sports: values.sport } : {}),
};
const saveDir = join(SITEMAPS_DIR, tenant.id);

let input: Input = base;
let cost = 0;
let steps = 0;
let outcome = "";
let lastRunId = "";

for (;;) {
  asked = undefined;
  const result = await run({
    tenantId: tenant.id,
    input,
    approver,
    sinks: [{ write: show }, ...(deps.tracing ? [deps.tracing.sink()] : [])],
  });
  cost += result.usage.costUsd;
  steps += result.usage.steps;
  lastRunId = result.runId;
  if (result.afterRunError) console.error(`memory consolidation failed: ${result.afterRunError}`);

  if (result.status === "completed") {
    outcome = `completed · saved to .runs/sitemaps/${tenant.id}/`;
    break;
  }
  if (result.status === "failed") {
    outcome = `failed (${result.reason}: ${result.message})`;
    break;
  }
  if (!asked) {
    outcome = "rejected · nothing saved";
    break;
  }

  // The run ended on the editor's request. Apply it to the sitemap that was on screen.
  let draft = result.output.input as Sitemap;
  let next: Review | undefined = asked;
  let finished = false;
  while (next?.kind === "path") {
    const edited = renamePath(draft, next.from, next.to);
    if (edited.ok) {
      draft = edited.sitemap;
      console.log(dim(`· ${next.from} is now ${next.to}`));
    } else {
      console.log(`Not changed:\n${edited.issues.map((i) => `  - ${i}`).join("\n")}`);
    }
    const reply = await review(draft);
    if (reply.kind === "approve") {
      const { unchanged } = await writeSitemap(saveDir, draft, lastRunId);
      outcome = `saved by hand-edit${unchanged ? " (no change)" : ""} · .runs/sitemaps/${tenant.id}/`;
      finished = true;
    } else if (reply.kind === "reject") {
      outcome = "rejected · nothing saved";
      finished = true;
    }
    next = finished ? undefined : reply;
  }
  if (finished) break;
  if (next?.kind !== "change") break;
  input = { ...base, revise: { sitemap: draft, request: next.request } };
}

console.log(`\n${outcome}`);
console.log(dim(`cost $${cost.toFixed(4)} · ${steps} steps · .runs/${lastRunId}/events.jsonl`));
lines.return?.();
await deps.tracing?.shutdown();
await deps.pool.end();
