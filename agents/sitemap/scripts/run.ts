// pnpm sitemap --tenant demo-cricket --brief "..." [--sport cricket] [--fast]
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { RunEvent } from "@dugout/contracts";
import { type Approver, loadTenants } from "@dugout/core";
import { createSitemap, liveDeps, type NavItem, type PageNode, sitemapOf } from "../src/index.ts";

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

const approver: Approver = async (req) => {
  const sitemap = sitemapOf(req);
  console.log("\n\n── Pages ──");
  printPages(sitemap.pages);
  console.log("\n── Header menu ──");
  printMenu(sitemap.navigation);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("\nApprove and save? [y/N] ")).trim().toLowerCase();
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
  else if (e.type === "tool.started") console.log(dim(`· ${e.data.tool}`));
  else if (e.type === "tool.denied") console.log(dim(`· denied ${e.data.tool}: ${e.data.reason}`));
  else if (e.type === "tool.completed" && !e.data.ok)
    console.log(dim(`· ${e.data.tool} failed: ${e.data.content}`));
};

const result = await run({
  tenantId: tenant.id,
  input: { brief: values.brief, ...(values.sport?.length ? { sports: values.sport } : {}) },
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
if (result.status === "completed") console.log(dim(`· saved to .runs/sitemaps/${tenant.id}/`));
if (result.afterRunError) console.error(`memory consolidation failed: ${result.afterRunError}`);
await deps.tracing?.shutdown();
await deps.pool.end();
