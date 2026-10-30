// pnpm agent <id> --tenant <tenant> [--<input field> <value>]... [--input <json>]
// pnpm agent --run <runId> --tenant <tenant> [--after <seq>]
//
// The terminal host for the workers (ADR 0009). It does what wnm-fanxp-backend does: queues a run,
// follows its events as a worker writes them, and at each approval asks: y approves, n rejects,
// anything else is a change that goes back to the agent in the same run. Needs `pnpm worker`.
// `--run` attaches to a run already queued, e.g. after Ctrl-C. `pnpm preview` and `pnpm sitemap`
// are this with the agent filled in.
import { main } from "../src/main.ts";

// named after the script that ran it, so `pnpm sitemap` shows `pnpm sitemap` in its usage line
const script = process.env.npm_lifecycle_event;
process.exitCode = await main(
  process.argv.slice(2),
  script && script !== "agent" ? `pnpm ${script}` : undefined,
);
