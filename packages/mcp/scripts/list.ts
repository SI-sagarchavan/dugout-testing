// pnpm agent mcp list — the registry's MCP servers: where each points, whether it is configured
// here, when its lock was synced, and which capabilities give which tools.
import { createMcpHost, toolName } from "../src/index.ts";
import { loadRepoEnv } from "./env.ts";

loadRepoEnv();
const host = createMcpHost();
if (host.registry.size === 0) console.log("No MCP servers in config/mcp.");
for (const server of host.registry.values()) {
  const lock = host.lock(server.id);
  const configured = host.hub.configured(server.id);
  console.log(`${server.id}  ${server.title}  (${server.environment}, owner ${server.owner})`);
  console.log(
    `  ${configured ? "configured" : "not configured here"}; ${lock ? `locked ${lock.syncedAt}, server ${lock.serverInfo.name} ${lock.serverInfo.version}` : "no lock: run pnpm agent mcp sync"}`,
  );
  for (const [id, capability] of Object.entries(server.capabilities)) {
    console.log(`  ${id}: ${capability.description}`);
    for (const [remote, grant] of Object.entries(capability.tools)) {
      const policy = server.tools[remote];
      const limits = [
        ...Object.entries(grant.arguments ?? {}).map(([arg, p]) => `${arg} ~ ${p}`),
        ...Object.entries(grant.set ?? {}).map(([arg, v]) => `${arg} = ${JSON.stringify(v)}`),
      ];
      console.log(
        `    ${toolName(server, remote)}  ${policy?.effect}${limits.length ? `  (${limits.join(", ")})` : ""}`,
      );
    }
    for (const uri of capability.resources ?? []) console.log(`    ${uri}  resource`);
  }
}
