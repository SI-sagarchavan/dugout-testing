import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { type AnyAgent, loadAgent } from "@dugout/sdk";
import {
  createRunQueue,
  createValkeyEventLog,
  LOCAL_VALKEY_URL,
  type RunQueue,
} from "@dugout/worker";
import { Valkey } from "iovalkey";
import { z } from "zod";
import { parseCliArgs, usage } from "./flags.ts";
import { dim, type Ending, followRun, type Terminal } from "./session.ts";

/**
 * `pnpm agent <id> --tenant <t> [input flags]` queues a run and follows it; `pnpm agent --run <runId>
 * --tenant <t> [--after <seq>]` attaches to one already queued; `pnpm agent --cancel <runId> --tenant
 * <t> [--reason <why>]` cancels one. A run id can be its first characters. Returns the exit code.
 */
export async function main(argv: string[], command?: string): Promise<number> {
  const [first, ...rest] = argv;
  if (!first) {
    console.error(
      "usage: pnpm agent <id> --tenant <tenant> ... | pnpm agent --run <runId> --tenant <tenant> | pnpm agent --cancel <runId> --tenant <tenant>",
    );
    return 2;
  }
  loadEnv();
  const pool = createPool();
  const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
  const events = createValkeyEventLog(valkey, { keyPrefix: process.env.VALKEY_KEY_PREFIX ?? "" });
  const queue = createRunQueue({ pool, events });
  // one reader for the whole session, so lines typed (or piped) ahead of a prompt are not lost
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const terminal: Terminal = {
    write: (text) => void process.stdout.write(text),
    line: (text) => console.log(text),
    async ask(prompt) {
      process.stdout.write(prompt);
      const { value, done } = await lines.next();
      if (done) process.stdout.write("\n");
      return done ? "" : String(value).trim();
    },
  };

  try {
    if (first === "--cancel") return await cancel(argv, queue);
    let agent: AnyAgent;
    let tenantId: string;
    let runId: string;
    let afterSeq = 0;
    if (first === "--run") {
      const attach = "usage: pnpm agent --run <runId> --tenant <tenant> [--after <seq>]";
      let values: {
        run?: string | undefined;
        tenant?: string | undefined;
        after?: string | undefined;
      };
      try {
        ({ values } = parseArgs({
          args: argv,
          options: {
            run: { type: "string" },
            tenant: { type: "string" },
            after: { type: "string" },
          },
        }));
      } catch (err) {
        console.error(`${(err as Error).message}\n${attach}`);
        return 2;
      }
      if (!values.run || !values.tenant) {
        console.error(attach);
        return 2;
      }
      tenantId = loadTenants().require(values.tenant).id;
      const run = await pickRun(queue, tenantId, values.run, "--run");
      if (!run) return 1;
      runId = run.id;
      agent = await loadAgent(run.agent_id);
      afterSeq = Number(values.after ?? 0);
    } else {
      agent = await loadAgent(first);
      const line = usage(agent, command);
      let args: ReturnType<typeof parseCliArgs>;
      try {
        args = parseCliArgs(agent, rest);
      } catch (err) {
        console.error(`${(err as Error).message}\nusage: ${line}`);
        return 2;
      }
      const parsed = agent.input.safeParse(args.input);
      if (!args.tenant || !parsed.success) {
        if (!parsed.success) console.error(z.prettifyError(parsed.error));
        console.error(`usage: ${line}`);
        return 2;
      }
      tenantId = loadTenants().require(args.tenant).id;
      runId = await queue.start(tenantId, agent.spec.id, parsed.data);
      terminal.line(dim(`· run ${runId} queued`));
    }

    // Ctrl-C leaves the run to its worker; attach again to carry on
    const stop = new AbortController();
    process.once("SIGINT", () => {
      stop.abort();
      console.log(dim(`\n· the run goes on in its worker; attach again with:`));
      console.log(`pnpm agent --run ${runId} --tenant ${tenantId}`);
      process.exit(130);
    });

    const ending = await followRun({
      queue,
      agent,
      tenantId,
      runId,
      afterSeq,
      terminal,
      by: userInfo().username,
      signal: stop.signal,
    });
    return ending ? report(ending, agent, tenantId) : 1;
  } finally {
    lines.return?.();
    valkey.disconnect();
    await pool.end();
  }
}

function report(ending: Ending, agent: Pick<AnyAgent, "cli">, tenantId: string) {
  const { usage } = ending.data;
  const cost = dim(
    `cost $${usage.costUsd.toFixed(4)} · ${usage.steps} steps · run ${ending.runId}`,
  );
  if (ending.type === "run.cancelled") {
    const why = ending.data.reason ? `: ${ending.data.reason}` : "";
    console.log(`\ncancelled by ${ending.data.by}${why}`);
    console.log(cost);
    return 1;
  }
  const status = ending.type === "run.completed" ? ending.data.status : "failed";
  const failure =
    ending.type === "run.failed" ? ` (${ending.data.reason}: ${ending.data.message})` : "";
  console.log(`\n${status}${failure}`);
  console.log(cost);
  const note = agent.cli.done?.({ status }, tenantId);
  if (note) console.log(dim(`· ${note}`));
  if (status === "rejected") console.log(dim("· the reason is saved to this tenant's memory"));
  return status === "failed" ? 1 : 0;
}

/** The one run of the tenant whose id starts with `prefix`; lists candidates when there isn't one. */
async function pickRun(queue: RunQueue, tenantId: string, prefix: string, flag: string) {
  const matches = await queue.matching(tenantId, prefix);
  if (matches.length === 1) return matches[0];
  const listed = matches.length ? matches : await queue.matching(tenantId, "");
  console.error(
    matches.length
      ? `several runs of ${tenantId} start with ${prefix}:`
      : `no run ${prefix} for tenant ${tenantId}${listed.length ? "; latest runs:" : ""}`,
  );
  for (const r of listed) {
    const at = r.updated_at.toISOString().slice(0, 16).replace("T", " ");
    console.error(`  ${r.id}  ${r.agent_id.padEnd(14)} ${r.status.padEnd(9)} ${at}`);
  }
  if (listed.length) {
    console.error(`try: pnpm agent ${flag} <id, or its first characters> --tenant ${tenantId}`);
  }
  return undefined;
}

/** `pnpm agent --cancel <runId> --tenant <t> [--reason <why>]`. */
async function cancel(argv: string[], queue: RunQueue): Promise<number> {
  const line = "usage: pnpm agent --cancel <runId> --tenant <tenant> [--reason <why>]";
  let values: {
    cancel?: string | undefined;
    tenant?: string | undefined;
    reason?: string | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        cancel: { type: "string" },
        tenant: { type: "string" },
        reason: { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${line}`);
    return 2;
  }
  if (!values.cancel || !values.tenant) {
    console.error(line);
    return 2;
  }
  const tenantId = loadTenants().require(values.tenant).id;
  const run = await pickRun(queue, tenantId, values.cancel, "--cancel");
  if (!run) return 1;
  const previous = await queue.cancel(tenantId, run.id, userInfo().username, values.reason);
  if (!previous) {
    console.error(`run ${run.id} had already ended (${run.status})`);
    return 1;
  }
  console.log(
    previous === "running"
      ? `run ${run.id} cancelled; its worker stops it at its next step`
      : `run ${run.id} cancelled (it was ${previous})`,
  );
  return 0;
}
