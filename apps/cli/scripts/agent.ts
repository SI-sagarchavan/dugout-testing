// pnpm agent                         menu, when a terminal is attached
// pnpm agent --help
// pnpm agent <id> --tenant <tenant> [--<input field> <value>]... [--input <json>]
// pnpm agent attach --run <runId> --tenant <tenant> [--after <seq>]
// pnpm agent cancel <runId> --tenant <tenant> [--reason <why>]
//
// The terminal host for the workers (ADR 0009). It does what wnm-fanxp-backend does: queues a run,
// follows its events as a worker writes them, and at each approval asks. A terminal offers
// approve, reject, or a change; a pipe answers y, n, or the change. Needs `pnpm worker`.
// Ctrl-C leaves the run going. Started through scripts/agent.ts, which also routes the tools
// (`watch`, `program`, `memory`, `schemas`).
import { main } from "../src/main.ts";

process.exitCode = await main(process.argv.slice(2));
