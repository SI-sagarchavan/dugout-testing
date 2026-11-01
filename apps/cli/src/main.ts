import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import type { ApprovalDecision, SavePoint } from "@dugout/contracts";
import { type ForkChange, loadEnv, loadModelConfig, loadTenants, runModel } from "@dugout/core";
import { createPool } from "@dugout/db";
import { type AnyAgent, agentIds, loadAgent } from "@dugout/sdk";
import {
  createRunQueue,
  createValkeyEventLog,
  LOCAL_VALKEY_URL,
  type RunQueue,
  type RunRow,
} from "@dugout/worker";
import { Valkey } from "iovalkey";
import pc from "picocolors";
import { z } from "zod";
import {
  banner,
  type ForkDecision,
  historyLine,
  type Intent,
  isCommand,
  parseIntent,
  renderAgentHelp,
  renderHelp,
  runLine,
  summaryOf,
  version,
} from "./commands.ts";
import { parseCliArgs, usage } from "./flags.ts";
import { dim, type Ending, followRun, type Terminal } from "./session.ts";
import {
  Cancelled,
  cancelSession,
  clackPrompter,
  closeSession,
  createTerminal,
  isInteractive,
  openSession,
  type Prompter,
  type PromptGate,
  say,
} from "./ui.ts";
import {
  askModel,
  chooseRun,
  completeInput,
  fieldSuggestions,
  pickAction,
  pickAgent,
  pickTenant,
} from "./wizard.ts";

/**
 * The terminal host for the workers (ADR 0009). With no arguments in a terminal it opens a menu.
 * `pnpm agent <id>` and `pnpm agent run <id>` queue a run and
 * follow it. `attach` and `--run` follow one already queued. `cancel` and `--cancel` stop one.
 * `history` and `--history` list a run's save points. `fork` and `--fork` start a new run from one.
 * A pipe keeps the old answers: `y`, `n`, or the text of a change.
 */
export async function main(argv: string[], command?: string): Promise<number> {
  try {
    return await start(argv, command);
  } catch (err) {
    if (err instanceof Cancelled) return 0;
    const message = userMessage(err);
    if (message) {
      console.error(message);
      return 1;
    }
    throw err;
  }
}

async function start(argv: string[], command?: string): Promise<number> {
  let intent = parseIntent(argv);
  if (intent.kind === "error") {
    console.error(intent.message);
    return 2;
  }
  if (intent.kind === "version") {
    console.log(`dugout ${version}`);
    return 0;
  }
  if (intent.kind === "help") return showHelp(intent.topic, command);

  const interactive = isInteractive();
  const gate: PromptGate = { prompting: false };
  const cancelMessage = { current: "Cancelled." };
  const onCancel = () => cancelSession(cancelMessage.current);
  let opened = false;

  if (intent.kind === "menu") {
    if (!interactive) {
      console.log(renderHelp());
      return 2;
    }
    openSession("dugout");
    opened = true;
    const action = await pickAction(clackPrompter(gate, onCancel));
    if (action === "agents") {
      await printAgents();
      closeSession("pnpm agent run <agent> --tenant <id>");
      return 0;
    }
    intent = action === "run" ? { kind: "run", argv: [] } : { kind: action };
  }

  if (intent.kind === "agents") {
    await printAgents();
    return 0;
  }

  return withHost(intent, {
    interactive,
    opened,
    gate,
    cancelMessage,
    onCancel,
    ...(command ? { command } : {}),
  });
}

async function showHelp(topic: string | undefined, command?: string): Promise<number> {
  if (!topic) {
    console.log(renderHelp());
    return 0;
  }
  if (isCommand(topic)) {
    console.log(renderHelp(topic));
    return 0;
  }
  try {
    console.log(renderAgentHelp(await loadAgent(topic), command));
    return 0;
  } catch (err) {
    console.error(userMessage(err) ?? (err as Error).message);
    console.log(renderHelp());
    return 2;
  }
}

interface Session {
  queue: RunQueue;
  terminal: Terminal;
  interactive: boolean;
  opened: boolean;
  gate: PromptGate;
  prompter?: Prompter;
  cancelMessage: { current: string };
  command?: string;
}

async function withHost(
  intent: Intent,
  opts: {
    interactive: boolean;
    opened: boolean;
    gate: PromptGate;
    cancelMessage: { current: string };
    onCancel: () => never;
    command?: string;
  },
): Promise<number> {
  loadEnv();
  const pool = createPool();
  const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
  const events = createValkeyEventLog(valkey, { keyPrefix: process.env.VALKEY_KEY_PREFIX ?? "" });
  const lines = opts.interactive
    ? undefined
    : createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const host: Session = {
    queue: createRunQueue({ pool, events }),
    terminal: createTerminal({
      interactive: opts.interactive,
      gate: opts.gate,
      onCancel: opts.onCancel,
      ...(lines ? { lines } : {}),
    }),
    interactive: opts.interactive,
    opened: opts.opened,
    gate: opts.gate,
    ...(opts.interactive ? { prompter: clackPrompter(opts.gate, opts.onCancel) } : {}),
    cancelMessage: opts.cancelMessage,
    ...(opts.command ? { command: opts.command } : {}),
  };
  try {
    return await dispatch(intent, host);
  } finally {
    await lines?.return?.();
    valkey.disconnect();
    await pool.end();
  }
}

async function dispatch(intent: Intent, host: Session): Promise<number> {
  if (intent.kind === "run") return startRun(host, intent.agentId, intent.argv);
  if (intent.kind === "attach") return attach(host, intent);
  if (intent.kind === "cancel") return cancelRun(host, intent);
  if (intent.kind === "runs") return listRuns(host, intent.tenant);
  if (intent.kind === "history") return showHistory(host, intent);
  if (intent.kind === "fork") return startFork(host, intent);
  console.error(renderHelp());
  return 2;
}

async function startRun(
  host: Session,
  agentId: string | undefined,
  argv: string[],
): Promise<number> {
  let id = agentId;
  if (!id) {
    if (!host.prompter) {
      console.error(renderHelp("run"));
      return 2;
    }
    id = await pickAgent(host.prompter);
  }
  const agent = await loadAgent(id);
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(agent, argv);
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: ${usage(agent, host.command)}`);
    return 2;
  }
  let tenantId = args.tenant;
  if (!tenantId) {
    if (!host.prompter) {
      console.error(`usage: ${usage(agent, host.command)}`);
      return 2;
    }
    tenantId = await pickTenant(host.prompter);
  }
  const tenant = loadTenants().require(tenantId);
  const input = host.prompter
    ? await completeInput({
        agent,
        given: args.input,
        askOptional: !explicitInput(argv),
        suggestions: (field) => fieldSuggestions(tenant, field),
        prompter: host.prompter,
      })
    : args.input;
  const parsed = agent.input.safeParse(input);
  if (!parsed.success) {
    console.error(z.prettifyError(parsed.error));
    console.error(`usage: ${usage(agent, host.command)}`);
    return 2;
  }
  let model = undefined as string | undefined;
  try {
    model = runModel(loadModelConfig(), agent.spec.model, args);
    if (!model && host.prompter && !explicitInput(argv)) {
      model = await askModel(host.prompter, agent.spec.model);
    }
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: ${usage(agent, host.command)}`);
    return 2;
  }
  const runId = await host.queue.start(tenant.id, agent.spec.id, parsed.data, {
    ...(model ? { model } : {}),
  });
  host.terminal.line(dim(`· run ${runId} queued${model ? ` on ${model}` : ""}`));
  return followAndReport(host, agent, tenant.id, runId, 0, args.yes);
}

/** A flag other than `--tenant` means the command already said what the run is. */
function explicitInput(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--" || (arg.startsWith("-") && arg !== "--tenant" && !arg.startsWith("--tenant=")),
  );
}

async function attach(
  host: Session,
  intent: { run?: string; tenant?: string; after?: string },
): Promise<number> {
  const tenantId = await requireTenant(
    host,
    intent.tenant,
    "usage: pnpm agent attach [run] --tenant <id>",
  );
  if (!tenantId) return 2;
  const after = sequence(intent.after);
  if (after === undefined) {
    console.error("--after takes a sequence number");
    return 2;
  }
  const run = await resolveRun({
    queue: host.queue,
    ...(host.prompter ? { prompter: host.prompter } : {}),
    tenantId,
    ...(intent.run ? { prefix: intent.run } : {}),
    retry: `pnpm agent attach <id> --tenant ${tenantId}`,
  });
  if (!run) return 1;
  return followAndReport(host, await loadAgent(run.agent_id), tenantId, run.id, after);
}

async function cancelRun(
  host: Session,
  intent: { run?: string; tenant?: string; reason?: string },
): Promise<number> {
  const tenantId = await requireTenant(
    host,
    intent.tenant,
    "usage: pnpm agent cancel [run] --tenant <id>",
  );
  if (!tenantId) return 2;
  const run = await resolveRun({
    queue: host.queue,
    ...(host.prompter ? { prompter: host.prompter } : {}),
    tenantId,
    openOnly: true,
    ...(intent.run ? { prefix: intent.run } : {}),
    retry: `pnpm agent cancel <id> --tenant ${tenantId}`,
  });
  if (!run) return 1;
  const by = userInfo().username;
  const previous = intent.reason
    ? await host.queue.cancel(tenantId, run.id, by, intent.reason)
    : await host.queue.cancel(tenantId, run.id, by);
  if (!previous) {
    console.error(`run ${run.id} had already ended (${run.status})`);
    return 1;
  }
  const line =
    previous === "running"
      ? `run ${run.id} cancelled; its worker stops it at its next step`
      : `run ${run.id} cancelled (it was ${previous})`;
  tell(host, line);
  if (host.interactive) closeSession("Cancelled");
  return 0;
}

async function showHistory(
  host: Session,
  intent: { run?: string; tenant?: string },
): Promise<number> {
  const tenantId = await requireTenant(
    host,
    intent.tenant,
    "usage: pnpm agent history [run] --tenant <id>",
  );
  if (!tenantId) return 2;
  const run = await resolveRun({
    queue: host.queue,
    ...(host.prompter ? { prompter: host.prompter } : {}),
    tenantId,
    ...(intent.run ? { prefix: intent.run } : {}),
    retry: `pnpm agent history <id> --tenant ${tenantId}`,
  });
  if (!run) return 1;
  return printHistory(host, tenantId, run.id);
}

async function printHistory(host: Session, tenantId: string, runId: string): Promise<number> {
  const points = await host.queue.history(tenantId, runId);
  console.log(
    `${pc.bold(runId)}  ${pc.dim(points.length === 1 ? "1 save point" : `${points.length} save points`)}`,
  );
  if (points.length === 0) {
    console.log(pc.dim("  No save points kept. A run keeps them once a worker has saved it."));
  }
  for (const point of points) console.log(historyLine(point));
  if (host.interactive) {
    closeSession(points.length === 1 ? "1 save point" : `${points.length} save points`);
  }
  return 0;
}

async function startFork(
  host: Session,
  intent: Extract<Intent, { kind: "fork" }>,
): Promise<number> {
  const usage = "usage: pnpm agent fork [run] --from <version> --tenant <id>";
  const tenantId = await requireTenant(host, intent.tenant, usage);
  if (!tenantId) return 2;
  const run = await resolveRun({
    queue: host.queue,
    ...(host.prompter ? { prompter: host.prompter } : {}),
    tenantId,
    ...(intent.run ? { prefix: intent.run } : {}),
    retry: `pnpm agent fork <id> --from <version> --tenant ${tenantId}`,
  });
  if (!run) return 1;
  const points = await host.queue.history(tenantId, run.id);
  if (points.length === 0) {
    console.error(`run ${run.id} has no save points`);
    return 1;
  }
  const version = await chooseVersion(host, intent.from, points, usage);
  if (version === undefined) return 2;
  const point = points.find((item) => item.version === version);
  if (!point) {
    console.error(`run ${run.id} has no save point ${version}`);
    for (const item of points) console.error(historyLine(item));
    return 1;
  }
  const change = await forkChange(host, intent, point);
  if (change === undefined) return 2;
  let forked: { runId: string; startSeq: number };
  try {
    forked = await host.queue.fork(tenantId, run.id, version, change);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  host.terminal.line(dim(`· fork ${forked.runId} queued from ${run.id} at save point ${version}`));
  return followAndReport(
    host,
    await loadAgent(run.agent_id),
    tenantId,
    forked.runId,
    forked.startSeq,
  );
}

/** The version named on the command line, or one picked from the list. Undefined when it is unusable. */
async function chooseVersion(
  host: Session,
  from: string | undefined,
  points: readonly SavePoint[],
  usage: string,
): Promise<number | undefined> {
  if (from === undefined) {
    if (!host.prompter) {
      console.error(usage);
      for (const point of points) console.error(historyLine(point));
      return undefined;
    }
    const picked = await host.prompter.select(
      "Save point",
      points.map((point) => ({
        value: String(point.version),
        label: `v${point.version}  ${point.savedAfter ?? "saved"}`,
        hint: `step ${point.step}${point.waiting ? ` · ${point.waiting.tool}` : ""}`,
      })),
    );
    return Number(picked);
  }
  if (!/^[1-9]\d*$/.test(from)) {
    console.error("--from takes a save point version");
    return undefined;
  }
  return Number(from);
}

type ForkRequest = ForkChange & { model?: string };

/**
 * The one change a fork takes. Flags win. A terminal with none is asked. A pipe with none runs
 * the save point again. Undefined after an error has already been printed.
 */
async function forkChange(
  host: Session,
  intent: Extract<Intent, { kind: "fork" }>,
  point: SavePoint,
): Promise<ForkRequest | undefined> {
  const by = userInfo().username;
  if (intent.decision) {
    if (!point.waiting) {
      console.error(`save point ${point.version} waits for no approval`);
      return undefined;
    }
    return { decision: decided(intent.decision, by) };
  }
  if (intent.model) return { model: intent.model };
  if (intent.input !== undefined) return { input: corrected(intent.input) };
  if (!host.prompter) return {};

  const options = [
    { value: "again", label: "Run it again", hint: "the same transcript, with no change" },
    ...(point.waiting
      ? [
          {
            value: "decision",
            label: "Another decision",
            hint: `the approval on ${point.waiting.tool}`,
          },
        ]
      : []),
    { value: "model", label: "Another model", hint: "a name from config/models.json" },
    { value: "input", label: "Corrected input", hint: "sent as the next user message" },
  ];
  const choice = await host.prompter.select("What should this fork change?", options);
  if (choice === "again") return {};
  if (choice === "model") {
    const names = Object.keys(loadModelConfig().models);
    const model = await host.prompter.select(
      "Model",
      names.map((name) => ({ value: name, label: name })),
    );
    return { model };
  }
  if (choice === "input") {
    const text = await host.prompter.multiline("Corrected input");
    return { input: corrected(text) };
  }
  const which = await host.prompter.select("Decision", [
    { value: "approve", label: "Approve" },
    { value: "reject", label: "Reject" },
    { value: "changes", label: "Request a change" },
  ]);
  if (which === "approve") return { decision: { approved: true, by } };
  if (which === "reject") {
    const reason = (await host.prompter.text("Reason")).trim();
    if (!reason) {
      console.error("a rejection needs a reason");
      return undefined;
    }
    return { decision: { approved: false, by, reason } };
  }
  const changes = (await host.prompter.multiline("Change")).trim();
  if (!changes) {
    console.error("a change request needs the change");
    return undefined;
  }
  return { decision: { approved: false, by, changes } };
}

function decided(decision: ForkDecision, by: string): ApprovalDecision {
  if (decision.approved) return { approved: true, by };
  if ("changes" in decision) return { approved: false, by, changes: decision.changes };
  return { approved: false, by, reason: decision.reason };
}

/** JSON when it parses, and the text itself when it does not. */
function corrected(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function listRuns(host: Session, tenant: string | undefined): Promise<number> {
  const tenantId = await requireTenant(host, tenant, "usage: pnpm agent runs --tenant <id>");
  if (!tenantId) return 2;
  const rows = await host.queue.matching(tenantId, "", 20);
  console.log(
    `${pc.bold(tenantId)}  ${pc.dim(rows.length === 1 ? "1 run" : `${rows.length} runs`)}`,
  );
  if (rows.length === 0) console.log(pc.dim("  Nothing queued yet."));
  for (const row of rows) console.log(runLine(row));
  if (host.interactive) closeSession(rows.length === 1 ? "1 run" : `${rows.length} runs`);
  return 0;
}

const OPEN = new Set<RunRow["status"]>(["queued", "running", "waiting"]);

async function resolveRun(opts: {
  queue: RunQueue;
  prompter?: Prompter;
  tenantId: string;
  prefix?: string;
  openOnly?: boolean;
  retry: string;
}): Promise<RunRow | undefined> {
  if (!opts.prefix) {
    let rows = await opts.queue.matching(opts.tenantId, "", 20);
    if (opts.openOnly) rows = rows.filter((run) => OPEN.has(run.status));
    if (rows.length === 0) {
      console.error(
        opts.openOnly
          ? `no open run for tenant ${opts.tenantId}`
          : `no runs for tenant ${opts.tenantId}`,
      );
      return undefined;
    }
    if (!opts.prompter) {
      console.error(opts.retry);
      for (const run of rows) console.error(runLine(run));
      return undefined;
    }
    const id = await chooseRun(opts.prompter, rows, opts.openOnly ? "Run to cancel" : "Run");
    return rows.find((run) => run.id === id);
  }

  const matches = await opts.queue.matching(opts.tenantId, opts.prefix);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && opts.prompter) {
    const id = await chooseRun(opts.prompter, matches, "Several runs match");
    return matches.find((run) => run.id === id);
  }
  const listed = matches.length > 0 ? matches : await opts.queue.matching(opts.tenantId, "");
  console.error(
    matches.length > 0
      ? `several runs of ${opts.tenantId} start with ${opts.prefix}:`
      : `no run ${opts.prefix} for tenant ${opts.tenantId}${listed.length > 0 ? "; latest runs:" : ""}`,
  );
  for (const run of listed) console.error(runLine(run));
  if (listed.length > 0) console.error(`try: ${opts.retry}`);
  return undefined;
}

async function requireTenant(
  host: Session,
  tenant: string | undefined,
  line: string,
): Promise<string | undefined> {
  if (!tenant) {
    if (!host.prompter) {
      console.error(line);
      return undefined;
    }
    return loadTenants().require(await pickTenant(host.prompter)).id;
  }
  return loadTenants().require(tenant).id;
}

async function followAndReport(
  host: Session,
  agent: AnyAgent,
  tenantId: string,
  runId: string,
  afterSeq: number,
  autoApprove = false,
): Promise<number> {
  host.cancelMessage.current = [
    "Cancelled. The run keeps going. Attach again with:",
    `pnpm agent attach --run ${runId} --tenant ${tenantId}`,
  ].join("\n");
  if (host.interactive && !host.opened) console.log(banner(agent.spec.id, tenantId));
  const stop = new AbortController();
  const onSigint = () => {
    if (host.gate.prompting) return;
    stop.abort();
    console.log(dim("\n· the run goes on in its worker; attach again with:"));
    console.log(`pnpm agent attach --run ${runId} --tenant ${tenantId}`);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    const ending = await followRun({
      queue: host.queue,
      agent,
      tenantId,
      runId,
      afterSeq,
      terminal: host.terminal,
      by: userInfo().username,
      signal: stop.signal,
      ...(autoApprove ? { autoApprove } : {}),
    });
    return ending ? report(ending, agent, tenantId, host.interactive) : 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function report(
  ending: Ending,
  agent: Pick<AnyAgent, "cli">,
  tenantId: string,
  interactive: boolean,
) {
  const { usage: runUsage } = ending.data;
  const cost = `cost $${runUsage.costUsd.toFixed(4)} · ${runUsage.steps} steps · run ${ending.runId}`;
  if (ending.type === "run.cancelled") {
    const why = ending.data.reason ? `: ${ending.data.reason}` : "";
    finish(interactive, `cancelled by ${ending.data.by}${why}`, [cost], "Cancelled");
    return 1;
  }
  const status = ending.type === "run.completed" ? ending.data.status : "failed";
  const failure =
    ending.type === "run.failed" ? ` (${ending.data.reason}: ${ending.data.message})` : "";
  const lines = [cost];
  const note = agent.cli.done?.({ status }, tenantId);
  if (note) lines.push(`· ${note}`);
  if (status === "rejected") lines.push("· the reason is saved to this tenant's memory");
  const headline = status.charAt(0).toUpperCase() + status.slice(1);
  finish(interactive, `${status}${failure}`, lines, headline);
  return status === "failed" ? 1 : 0;
}

/** The same words either way. A terminal closes the session; a pipe prints plain lines. */
function finish(interactive: boolean, status: string, lines: string[], headline: string) {
  if (!interactive) {
    console.log(`\n${status}`);
    for (const line of lines) console.log(dim(line));
    return;
  }
  say(status);
  for (const line of lines) say(dim(line));
  closeSession(headline);
}

function tell(host: Session, message: string) {
  if (host.interactive) say(message);
  else console.log(message);
}

async function printAgents(): Promise<void> {
  const ids = await agentIds();
  console.log(pc.bold("Agents"));
  console.log();
  for (const id of ids) {
    const agent = await loadAgent(id);
    console.log(`  ${pc.cyan(id)}`);
    console.log(pc.dim(`    ${agent.spec.owner} · ${agent.spec.model}`));
    console.log(`    ${summaryOf(agent.spec.instructions)}`);
    console.log();
  }
}

function sequence(after: string | undefined): number | undefined {
  if (after === undefined) return 0;
  return /^\d+$/.test(after) ? Number(after) : undefined;
}

function userMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (
    err.message.startsWith("unknown tenant") ||
    err.message.startsWith("no agent") ||
    err.message.includes("must export `agent`")
  ) {
    return err.message;
  }
  return undefined;
}
