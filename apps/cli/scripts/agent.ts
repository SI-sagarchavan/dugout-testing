// pnpm agent                         menu, when a terminal is attached
// pnpm agent --help
// pnpm agent <id> --tenant <tenant> [--<input field> <value>]... [--input <json>]
// pnpm agent attach --run <runId> --tenant <tenant> [--after <seq>]
// pnpm agent cancel <runId> --tenant <tenant> [--reason <why>]
//
// The terminal host for the workers (ADR 0009). It does what wnm-fanxp-backend does: queues a run,
// follows its events as a worker writes them, and at each approval asks. A terminal offers
// approve, reject, or a change; a pipe answers y, n, or the change. Needs `pnpm worker`.
// Ctrl-C leaves the run going. `pnpm preview`, `pnpm sitemap` and `pnpm matchday` are this with the
// agent filled in.
import { main } from "../src/main.ts";

// named after the script that ran it, so `pnpm sitemap` shows `pnpm sitemap` in its usage line
const script = process.env.npm_lifecycle_event;
process.exitCode = await main(
  process.argv.slice(2),
  script && script !== "agent" ? `pnpm ${script}` : undefined,
);
