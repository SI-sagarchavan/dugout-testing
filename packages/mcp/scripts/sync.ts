// pnpm agent mcp sync <server> --tenant <tenant> [--check] — reads the live server and writes its
// lock: the instructions, each listed tool's definition and each granted resource, hashed. Review the lock's diff before
// committing it: it is what agents read. --check writes nothing and exits 1 if the lock is stale.
import { parseArgs } from "node:util";
import { createMcpHost, syncServer } from "../src/index.ts";
import { loadRepoEnv } from "./env.ts";

loadRepoEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tenant: { type: "string" }, check: { type: "boolean", default: false } },
});
const serverId = positionals[0];
if (!serverId || !values.tenant) {
  console.error("usage: pnpm agent mcp sync <server> --tenant <tenant> [--check]");
  process.exit(2);
}
const host = createMcpHost();
try {
  const report = await syncServer(host, serverId, values.tenant, { write: !values.check });
  const { lock } = report;
  console.log(
    `${serverId}: ${lock.serverInfo.name} ${lock.serverInfo.version}, protocol ${lock.protocolVersion ?? "?"}`,
  );
  console.log(
    `  ${Object.keys(lock.tools).length} tool(s) locked; ${report.unlisted.length} on the server not listed (unreachable)`,
  );
  console.log(
    `  instructions: ${lock.instructions ? `${lock.instructions.length} chars` : "none"}`,
  );
  const resources = Object.keys(lock.resources ?? {});
  if (resources.length)
    console.log(`  ${resources.length} resource(s) locked: ${resources.join(", ")}`);
  for (const change of report.changes) console.log(`  change: ${change}`);
  for (const warning of report.warnings) console.log(`  check: ${warning}`);
  for (const error of report.errors) console.log(`  ERROR: ${error}`);
  if (report.errors.length) {
    console.log("Not written: fix config/mcp first.");
    process.exitCode = 1;
  } else if (values.check) {
    if (report.changes.length) process.exitCode = 1;
    console.log(report.changes.length ? "The lock is stale." : "The lock matches the server.");
  } else {
    console.log(`Wrote ${report.path}. Review its diff before committing it.`);
  }
} finally {
  await host.close();
}
