import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { type AnyAgent, loadAgent } from "@dugout/sdk";
import { createRunQueue, createValkeyEventLog, LOCAL_VALKEY_URL } from "@dugout/worker";
import { Valkey } from "iovalkey";
import { z } from "zod";
import { parseCliArgs, usage } from "./flags.ts";
import { dim, type Ending, followRun, type Terminal } from "./session.ts";

/**
 * `pnpm agent <id> --tenant <t> [input flags]` queues a run and follows it; `pnpm agent --run <runId>
 * --tenant <t> [--after <seq>]` attaches to one already queued. Returns the exit code.
 */
export async function main(argv: string[], command?: string): Promise<number> {
  const [first, ...rest] = argv;
  if (!first) {
    console.error(
      "usage: pnpm agent <id> --tenant <tenant> ... | pnpm agent --run <runId> --tenant <tenant>",
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
      // the whole id, or enough of its first characters to pick one run
      const matches = await queue.matching(tenantId, values.run);
      const run = matches.length === 1 ? matches[0] : undefined;
      if (!run) {
        const listed = matches.length ? matches : await queue.matching(tenantId, "");
        console.error(
          matches.length
            ? `several runs of ${tenantId} start with ${values.run}:`
            : `no run ${values.run} for tenant ${tenantId}${listed.length ? "; latest runs:" : ""}`,
        );
        for (const r of listed) {
          const at = r.updated_at.toISOString().slice(0, 16).replace("T", " ");
          console.error(`  ${r.id}  ${r.agent_id.padEnd(14)} ${r.status.padEnd(9)} ${at}`);
        }
        if (listed.length) {
          console.error(
            `attach with: pnpm agent --run <id, or its first characters> --tenant ${tenantId}`,
          );
        }
        return 1;
      }
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
  const status = ending.type === "run.completed" ? ending.data.status : "failed";
  const failure =
    ending.type === "run.failed" ? ` (${ending.data.reason}: ${ending.data.message})` : "";
  const { usage } = ending.data;
  console.log(`\n${status}${failure}`);
  console.log(
    dim(`cost $${usage.costUsd.toFixed(4)} · ${usage.steps} steps · run ${ending.runId}`),
  );
  const note = agent.cli.done?.({ status }, tenantId);
  if (note) console.log(dim(`· ${note}`));
  if (status === "rejected") console.log(dim("· the reason is saved to this tenant's memory"));
  return status === "failed" ? 1 : 0;
}
