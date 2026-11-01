// pnpm agent ... : the terminal host for the workers (ADR 0009), and the tools around it
// (apps/cli/src/tool-tables.ts). Anything that is not a tool goes to the host.
import { AGENT_TOOLS } from "../apps/cli/src/tool-tables.ts";
import { dispatch } from "../apps/cli/src/tools.ts";

await dispatch(AGENT_TOOLS, process.argv.slice(2), "apps/cli/scripts/agent.ts", "pnpm agent");
