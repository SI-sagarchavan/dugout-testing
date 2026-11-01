import { readFileSync } from "node:fs";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { SavePoint } from "@dugout/contracts";
import type { AnyAgent } from "@dugout/sdk";
import pc from "picocolors";
import { inputFields, usage } from "./flags.ts";

/**
 * Commands and help, in the shape of the GitHub CLI and the Vercel CLI: a short list of
 * commands, a help screen, and the old `pnpm agent <id>` form still accepted.
 * Each agent's flags are generated from its input schema (`flags.ts`), so those stay there.
 * citty, which the Nuxt CLI uses, fits a fixed command tree and would fight that generated grammar.
 */
export const version = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const COMMANDS = [
  {
    name: "run",
    syntax: "run <agent>",
    summary: "Queue a run and follow it",
    about: "Queue a run and follow it until it ends or asks for an approval.",
    usage: [
      "pnpm agent run <agent> --tenant <id> [flags]",
      "pnpm agent <agent> --tenant <id> [flags]",
    ],
    body: [
      "Leave the flags off in a terminal and you are asked for them.",
      "pnpm agent <agent> --help lists that agent's flags.",
    ],
    examples: [
      "pnpm agent run match-preview --tenant demo-cricket --fixture c-101",
      "pnpm preview --tenant demo-cricket --fixture c-101",
    ],
  },
  {
    name: "attach",
    syntax: "attach [run]",
    summary: "Follow a run already queued",
    about: "Follow a run that is already queued. A run id can be its first characters.",
    usage: [
      "pnpm agent attach [run] --tenant <id> [--after <seq>]",
      "pnpm agent --run <run> --tenant <id> [--after <seq>]",
    ],
    body: ["--after skips events up to that sequence and continues from there."],
    examples: [
      "pnpm agent attach --tenant demo-cricket",
      "pnpm agent attach --run 4f2a --tenant demo-cricket",
    ],
  },
  {
    name: "cancel",
    syntax: "cancel [run]",
    summary: "Stop a queued, running, or waiting run",
    about: "Stop a run that is queued, running, or waiting.",
    usage: [
      "pnpm agent cancel [run] --tenant <id> [--reason <why>]",
      "pnpm agent --cancel <run> --tenant <id> [--reason <why>]",
    ],
    body: ["A running run stops at its worker's next step."],
    examples: [
      "pnpm agent cancel --tenant demo-cricket",
      'pnpm agent cancel 4f2a --tenant demo-cricket --reason "wrong fixture"',
    ],
  },
  {
    name: "runs",
    syntax: "runs",
    summary: "List a tenant's recent runs",
    about: "List a tenant's recent runs, newest first.",
    usage: ["pnpm agent runs --tenant <id>"],
    body: ["Leave the tenant off in a terminal and you are asked which one."],
  },
  {
    name: "history",
    syntax: "history [run]",
    summary: "List a run's save points",
    about: "List every save point still kept for a run, oldest first.",
    usage: ["pnpm agent history [run] --tenant <id>", "pnpm agent --history <run> --tenant <id>"],
    body: [
      "Each line is a version you can fork from.",
      "A run saved before save points were kept has none.",
    ],
    examples: ["pnpm agent history 4f2a --tenant demo-cricket"],
  },
  {
    name: "fork",
    syntax: "fork [run]",
    summary: "Start a new run from a save point",
    about:
      "Queue a new run from a save point of another, then follow it. The parent is left as it is.",
    usage: [
      "pnpm agent fork [run] --from <version> --tenant <id> [--model <name>] [--input <json>]",
      "pnpm agent --fork <run> --from <version> --tenant <id> [--approve | --reject <reason> | --changes <text>]",
    ],
    body: [
      "A fork takes one change: the decision on the approval that save point waits for, another model, or a corrected input.",
      "With no change, it runs again from that point. The parent's transcript is copied unchanged.",
    ],
    examples: [
      "pnpm agent fork 4f2a --from 6 --tenant demo-cricket --model sonnet",
      'pnpm agent --fork 4f2a --from 4 --tenant demo-cricket --changes "use /fanzone"',
    ],
  },
  {
    name: "agents",
    syntax: "agents",
    summary: "List the agents you can run",
    about: "List the agents in agents/. The folder name is the id.",
    usage: ["pnpm agent agents"],
  },
  {
    name: "help",
    syntax: "help [command]",
    summary: "Show help for a command or an agent",
    about: "Show help for a command or an agent.",
    usage: [
      "pnpm agent help [command]",
      "pnpm agent <command> --help",
      "pnpm agent <agent> --help",
    ],
  },
] as const;

export type CommandName = (typeof COMMANDS)[number]["name"];

export function isCommand(name: string): name is CommandName {
  return COMMANDS.some((command) => command.name === name);
}

const VALUE_FLAGS = new Set([
  "--tenant",
  "--run",
  "--cancel",
  "--after",
  "--reason",
  "--input",
  "--history",
  "--fork",
  "--from",
  "--model",
  "--effort",
  "--reject",
  "--changes",
]);

/** A decision named on the command line. `by` is filled in when the fork is queued. */
export type ForkDecision =
  | { approved: true }
  | { approved: false; reason: string }
  | { approved: false; changes: string };

/** What the command line asked for, before any agent is loaded or any prompt is shown. */
export type Intent =
  | { kind: "menu" }
  | { kind: "version" }
  | { kind: "help"; topic?: string }
  | { kind: "agents" }
  | { kind: "runs"; tenant?: string }
  | { kind: "attach"; run?: string; tenant?: string; after?: string }
  | { kind: "cancel"; run?: string; tenant?: string; reason?: string }
  | { kind: "history"; run?: string; tenant?: string }
  | {
      kind: "fork";
      run?: string;
      tenant?: string;
      from?: string;
      model?: string;
      input?: string;
      decision?: ForkDecision;
    }
  | { kind: "run"; agentId?: string; argv: string[] }
  | { kind: "error"; message: string };

export function parseIntent(argv: string[]): Intent {
  if (argv.length === 0) return { kind: "menu" };
  const [first] = argv;
  if (!first) return { kind: "menu" };
  if (argv.length === 1 && (first === "--version" || first === "-v")) return { kind: "version" };
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    const topic = helpTopic(argv);
    return topic ? { kind: "help", topic } : { kind: "help" };
  }
  if (first === "help") {
    const topic = argv[1];
    if (argv.length > 2 || (topic?.startsWith("-") ?? false)) {
      return { kind: "error", message: "usage: pnpm agent help [command]" };
    }
    return topic ? { kind: "help", topic } : { kind: "help" };
  }
  if (first === "agents") {
    return argv.length === 1
      ? { kind: "agents" }
      : { kind: "error", message: "usage: pnpm agent agents" };
  }
  if (first === "runs") return parseRuns(argv.slice(1));
  if (first === "attach") return parseAttach(argv.slice(1));
  if (first === "cancel") return parseCancel(argv.slice(1));
  if (first === "history") return parseHistory(argv.slice(1));
  if (first === "fork") return parseFork(argv.slice(1));
  if (first === "--run") return parseAttach(argv);
  if (first === "--cancel") return parseCancel(argv);
  if (first === "--history") return parseHistory(argv);
  if (first === "--fork") return parseFork(argv);
  if (first === "run") {
    const rest = argv.slice(1);
    const agentId = rest[0];
    if (agentId && !agentId.startsWith("-")) {
      return { kind: "run", agentId, argv: rest.slice(1) };
    }
    return { kind: "run", argv: rest };
  }
  if (!first.startsWith("-")) return { kind: "run", agentId: first, argv: argv.slice(1) };
  return {
    kind: "error",
    message: `unknown option ${first}\n${renderHelp()}`,
  };
}

/**
 * The word `--help` is about. `run <agent> --help` is the agent's help, because that is
 * where the flags are. Anything else is the first word that is not a flag.
 */
function helpTopic(argv: string[]): string | undefined {
  const subjects = subjectsOf(argv);
  if ((subjects[0] === "run" || subjects[0] === "help") && subjects[1]) return subjects[1];
  return subjects[0];
}

function subjectsOf(argv: string[]): string[] {
  const subjects: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg === "--help" || arg === "-h") continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    subjects.push(arg);
  }
  return subjects;
}

function parseRuns(argv: string[]): Intent {
  const parsed = take(argv, { tenant: { type: "string" } }, "usage: pnpm agent runs --tenant <id>");
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  if (parsed.positionals.length > 0) {
    return { kind: "error", message: "usage: pnpm agent runs --tenant <id>" };
  }
  const tenant = parsed.values.tenant;
  return tenant ? { kind: "runs", tenant } : { kind: "runs" };
}

function parseAttach(argv: string[]): Intent {
  const line = "usage: pnpm agent attach [run] --tenant <id> [--after <seq>]";
  const parsed = take(
    argv,
    { run: { type: "string" }, tenant: { type: "string" }, after: { type: "string" } },
    line,
  );
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  const run = parsed.positionals[0] ?? parsed.values.run;
  if (parsed.positionals.length > 1) return { kind: "error", message: line };
  return {
    kind: "attach",
    ...(run ? { run } : {}),
    ...(parsed.values.tenant ? { tenant: parsed.values.tenant } : {}),
    ...(parsed.values.after ? { after: parsed.values.after } : {}),
  };
}

function parseCancel(argv: string[]): Intent {
  const line = "usage: pnpm agent cancel [run] --tenant <id> [--reason <why>]";
  const parsed = take(
    argv,
    {
      cancel: { type: "string" },
      run: { type: "string" },
      tenant: { type: "string" },
      reason: { type: "string" },
    },
    line,
  );
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  const run = parsed.positionals[0] ?? parsed.values.cancel ?? parsed.values.run;
  if (parsed.positionals.length > 1) return { kind: "error", message: line };
  return {
    kind: "cancel",
    ...(run ? { run } : {}),
    ...(parsed.values.tenant ? { tenant: parsed.values.tenant } : {}),
    ...(parsed.values.reason ? { reason: parsed.values.reason } : {}),
  };
}

function parseHistory(argv: string[]): Intent {
  const line = "usage: pnpm agent history [run] --tenant <id>";
  const parsed = take(
    argv,
    { history: { type: "string" }, run: { type: "string" }, tenant: { type: "string" } },
    line,
  );
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  const run = parsed.positionals[0] ?? parsed.values.history ?? parsed.values.run;
  if (parsed.positionals.length > 1) return { kind: "error", message: line };
  return {
    kind: "history",
    ...(run ? { run } : {}),
    ...(parsed.values.tenant ? { tenant: parsed.values.tenant } : {}),
  };
}

function parseFork(argv: string[]): Intent {
  const line = [
    "usage: pnpm agent fork [run] --from <version> --tenant <id>",
    "       [--model <name>] [--input <json>] [--approve | --reject <reason> | --changes <text>]",
  ].join("\n");
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        fork: { type: "string" },
        run: { type: "string" },
        from: { type: "string" },
        tenant: { type: "string" },
        model: { type: "string" },
        input: { type: "string" },
        approve: { type: "boolean" },
        reject: { type: "string" },
        changes: { type: "string" },
      },
    });
  } catch (err) {
    return { kind: "error", message: `${(err as Error).message}\n${line}` };
  }
  const text = (key: string) => {
    const value = parsed.values[key];
    return typeof value === "string" ? value : undefined;
  };
  const run = parsed.positionals[0] ?? text("fork") ?? text("run");
  if (parsed.positionals.length > 1) return { kind: "error", message: line };
  const approve = parsed.values.approve === true;
  const reject = text("reject");
  const changes = text("changes");
  const decisions = [approve, reject !== undefined, changes !== undefined].filter(Boolean);
  if (decisions.length > 1) {
    return { kind: "error", message: `a fork takes one decision\n${line}` };
  }
  const decision: ForkDecision | undefined = approve
    ? { approved: true }
    : reject !== undefined
      ? { approved: false, reason: reject }
      : changes !== undefined
        ? { approved: false, changes }
        : undefined;
  const model = text("model");
  const input = text("input");
  const tenant = text("tenant");
  const from = text("from");
  const changesTaken = [model, input, decision].filter((item) => item !== undefined).length;
  if (changesTaken > 1) {
    return {
      kind: "error",
      message: `a fork takes one change: a decision, another model, or a corrected input\n${line}`,
    };
  }
  return {
    kind: "fork",
    ...(run ? { run } : {}),
    ...(tenant ? { tenant } : {}),
    ...(from ? { from } : {}),
    ...(model ? { model } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(decision ? { decision } : {}),
  };
}

function take(argv: string[], options: NonNullable<ParseArgsConfig["options"]>, line: string) {
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true });
    const values: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(parsed.values)) {
      if (typeof value === "string") values[key] = value;
    }
    return { values, positionals: parsed.positionals };
  } catch (err) {
    return { error: `${(err as Error).message}\n${line}` };
  }
}

const paint = {
  title: (text: string) => pc.bold(pc.cyan(text)),
  heading: (text: string) => pc.bold(text),
  name: (text: string) => pc.cyan(text),
  dim: (text: string) => pc.dim(text),
};

/** Help for the whole CLI, or for one command. Plain text when the terminal has no color. */
export function renderHelp(topic?: CommandName): string {
  const command = topic ? COMMANDS.find((item) => item.name === topic) : undefined;
  if (topic && command) return renderCommand(command);
  return renderRoot();
}

function renderRoot(): string {
  const width = Math.max(...COMMANDS.map((command) => command.syntax.length));
  const lines = [
    paint.title("dugout"),
    "",
    "Queue a run, follow it, and decide its approvals. A worker (pnpm worker)",
    "carries the run out. The CLI never runs an agent itself.",
    "",
    paint.heading("Usage"),
    "  pnpm agent",
    "  pnpm agent <agent> --tenant <id> [flags]",
    "  pnpm agent <command> [options]",
    "",
    paint.heading("Commands"),
    ...COMMANDS.map(
      (command) => `  ${paint.name(command.syntax.padEnd(width))}  ${command.summary}`,
    ),
    "",
    paint.heading("Options"),
    `  ${paint.name("--help".padEnd(12))}  Show this help`,
    `  ${paint.name("--version".padEnd(12))}  Show the version`,
    "",
    paint.heading("Shortcuts"),
    `  ${paint.name("pnpm preview".padEnd(16))}  match-preview`,
    `  ${paint.name("pnpm sitemap".padEnd(16))}  sitemap`,
    `  ${paint.name("pnpm matchday".padEnd(16))}  matchday`,
    "",
    "At an approval, a terminal asks you to approve, reject, or request a change.",
    "A pipe answers y, n, or the change itself. Ctrl-C leaves the run going.",
    "",
    paint.dim("  pnpm agent attach --run <runId> --tenant <id>"),
  ];
  return lines.join("\n");
}

function renderCommand(command: (typeof COMMANDS)[number]): string {
  const lines = [paint.title(command.name), "", command.about, "", paint.heading("Usage")];
  for (const line of command.usage) lines.push(`  ${line}`);
  if ("body" in command) {
    lines.push("");
    for (const line of command.body) lines.push(line);
  }
  if ("examples" in command) {
    lines.push("", paint.heading("Examples"));
    for (const line of command.examples) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/** The first sentence of an agent's instructions, for lists and help. */
export function summaryOf(instructions: string): string {
  const line = instructions.split("\n").find((item) => item.trim()) ?? "";
  return (line.split(/(?<=\.)\s/)[0] ?? line).trim();
}

/** Help for one agent: what it does, and the flags its input schema takes. */
export function renderAgentHelp(
  agent: Pick<AnyAgent, "spec" | "input" | "cli">,
  command?: string,
): string {
  const fields = inputFields(agent.input, agent.cli.flags);
  const syntaxes = ["--tenant <id>", ...fields.map(flagSyntax), "--input <json>"];
  const width = Math.max(...syntaxes.map((syntax) => syntax.length));
  const row = (syntax: string, detail: string) =>
    `  ${paint.name(syntax.padEnd(width))}  ${detail}`;
  const lines = [
    paint.title(agent.spec.id),
    paint.dim(`${agent.spec.owner} · ${agent.spec.model}`),
    "",
    summaryOf(agent.spec.instructions),
    "",
    paint.heading("Usage"),
    `  ${usage(agent, command)}`,
    "",
    paint.heading("Flags"),
    row("--tenant <id>", "Tenant this run belongs to"),
    ...fields.map((field) =>
      row(flagSyntax(field), field.description ?? (field.required ? "Required" : "Optional")),
    ),
    row("--input <json>", "Any field as JSON, merged over the flags"),
  ];
  return lines.join("\n");
}

function flagSyntax(field: { flag: string; field: string; kind: string }): string {
  if (field.kind === "boolean") return `--${field.flag}`;
  const repeat = field.kind === "strings" ? "..." : "";
  return `--${field.flag} <${field.field}>${repeat}`;
}

const STATUS: Record<string, (text: string) => string> = {
  queued: pc.dim,
  running: pc.cyan,
  waiting: pc.yellow,
  completed: pc.green,
  rejected: pc.yellow,
  failed: pc.red,
  cancelled: pc.dim,
};

export function stamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** One save point, aligned for a list. The version is what `--from` takes. */
export function historyLine(point: SavePoint): string {
  const after = (point.savedAfter ?? "—").padEnd(8);
  const wait = point.waiting ? `  waiting on ${point.waiting.tool}` : "";
  const when = stamp(new Date(point.savedAt));
  return `  ${String(point.version).padStart(3)}  ${after}  step ${String(point.step).padStart(3)}  ${String(point.messages).padStart(3)} messages${wait}  ${pc.dim(when)}`;
}

/** One run, aligned for a list. The id stays whole so it can be copied. */
export function runLine(run: {
  id: string;
  agent_id: string;
  status: string;
  updated_at: Date;
}): string {
  const paintStatus = STATUS[run.status] ?? pc.dim;
  return `  ${pc.dim(run.id)}  ${run.agent_id.padEnd(16)} ${paintStatus(run.status.padEnd(9))} ${pc.dim(stamp(run.updated_at))}`;
}

/** A one-line banner for a run whose flags were all on the command line. */
export function banner(agentId: string, tenantId: string): string {
  return `${paint.title("dugout")}  ${paint.dim("·")}  ${agentId}  ${paint.dim("·")}  ${tenantId}`;
}
