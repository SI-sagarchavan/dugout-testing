// pnpm agent <id> --tenant <tenant> [--<input field> <value>]... [--input <json>] [--fast]
//
// Runs any agent in agents/ with a terminal approval prompt: y approves, n rejects, anything else
// is a change that goes back to the agent in the same run. `pnpm preview` and `pnpm sitemap` are
// this with the agent filled in.
import { agentIds, loadAgent, runCli } from "../src/index.ts";

const [id, ...argv] = process.argv.slice(2);
if (!id || id.startsWith("-")) {
  console.error(
    `usage: pnpm agent <id> --tenant <tenant> ... (agents: ${(await agentIds()).join(", ")})`,
  );
  process.exit(2);
}
const agent = await loadAgent(id);
// named after the script that ran it, so `pnpm sitemap` shows `pnpm sitemap` in its usage line
const script = process.env.npm_lifecycle_event;
process.exitCode = await runCli(
  agent,
  argv,
  script && script !== "agent" ? `pnpm ${script}` : undefined,
);
