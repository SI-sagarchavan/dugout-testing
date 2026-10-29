import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { ApprovalRequest, RunEvent } from "@dugout/contracts";
import { type Approver, loadTenants } from "@dugout/core";
import { z } from "zod";
import type { AgentResult, AnyAgent } from "./agent.ts";
import { liveDeps } from "./live.ts";

/** Flags every agent takes; an input field with one of these names goes through `--input`. */
const RESERVED = new Set(["tenant", "fast", "input"]);

export interface InputFlag {
  field: string;
  kind: "string" | "strings" | "number" | "boolean";
  required: boolean;
}

/**
 * The command-line flags for an input schema: one per top-level field of a plain type (string,
 * enum, number, boolean, or a list of strings), under its own name and any alias. Other fields
 * can still be given in `--input '<json>'`.
 */
export function inputFlags(schema: z.ZodType, aliases: Record<string, string> = {}) {
  const flags = new Map<string, InputFlag>();
  if (!(schema instanceof z.ZodObject)) return flags;
  for (const [field, type] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    let inner = type;
    let required = true;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      required = false;
      inner = inner.unwrap() as z.ZodType;
    }
    const kind = kindOf(inner);
    if (!kind || RESERVED.has(field)) continue;
    flags.set(field, { field, kind, required });
  }
  for (const [alias, field] of Object.entries(aliases)) {
    const flag = flags.get(field);
    if (flag && !RESERVED.has(alias)) flags.set(alias, flag);
  }
  return flags;
}

function kindOf(type: z.ZodType): InputFlag["kind"] | undefined {
  if (type instanceof z.ZodString || type instanceof z.ZodEnum) return "string";
  if (type instanceof z.ZodNumber) return "number";
  if (type instanceof z.ZodBoolean) return "boolean";
  if (type instanceof z.ZodArray) {
    const element = type.element as z.ZodType;
    if (element instanceof z.ZodString || element instanceof z.ZodEnum) return "strings";
  }
  return undefined;
}

/** `--tenant`, `--fast`, `--input <json>` and the input's own flags, as the agent's raw input. */
export function parseCliArgs(agent: Pick<AnyAgent, "input" | "cli">, argv: string[]) {
  const flags = inputFlags(agent.input, agent.cli.flags);
  const options: NonNullable<ParseArgsConfig["options"]> = {
    tenant: { type: "string" },
    fast: { type: "boolean", default: false },
    input: { type: "string" },
  };
  for (const [name, flag] of flags) {
    options[name] =
      flag.kind === "boolean"
        ? { type: "boolean" }
        : { type: "string", ...(flag.kind === "strings" ? { multiple: true } : {}) };
  }
  const { values } = parseArgs({ args: argv, options });
  const input: Record<string, unknown> =
    typeof values.input === "string" ? JSON.parse(values.input) : {};
  for (const [name, flag] of flags) {
    const value = values[name];
    if (value === undefined) continue;
    input[flag.field] = flag.kind === "number" ? Number(value) : value;
  }
  return {
    tenant: typeof values.tenant === "string" ? values.tenant : undefined,
    fast: values.fast === true,
    input,
  };
}

/** One usage line, naming each field by its alias when it has one. */
export function usage(
  agent: Pick<AnyAgent, "spec" | "input" | "cli">,
  command = `pnpm agent ${agent.spec.id}`,
) {
  // aliases come after field names, so the last name seen for a field is its alias
  const byField = new Map<string, [string, InputFlag]>();
  for (const [name, flag] of inputFlags(agent.input, agent.cli.flags)) {
    byField.set(flag.field, [name, flag]);
  }
  const parts = [...byField.values()].map(([name, flag]) => {
    const text = flag.kind === "boolean" ? `--${name}` : `--${name} <${flag.field}>`;
    const repeat = flag.kind === "strings" ? "..." : "";
    return flag.required ? `${text}${repeat}` : `[${text}]${repeat}`;
  });
  return [command, "--tenant <id>", ...parts, "[--input <json>]", "[--fast]"].join(" ");
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const clip = (s: string, max = 100) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const presentAsJson = (req: ApprovalRequest) =>
  `── ${req.tool} ──\n${JSON.stringify(req.input, null, 2)}`;

/**
 * Runs an agent in the terminal with live deps. At an approval it shows the request and asks:
 * `y` approves, `n` rejects (with a reason), anything else is a change request that goes back to
 * the agent in the same run (ADR 0005). Returns the exit code.
 */
export async function runCli(agent: AnyAgent, argv: string[], command?: string): Promise<number> {
  const line = usage(agent, command);
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(agent, argv);
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
  const tenant = loadTenants().require(args.tenant);
  const deps = liveDeps({ fast: args.fast });

  // one reader for the whole session, so lines typed (or piped) ahead of a prompt are not lost
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const ask = async (prompt: string) => {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    if (done) process.stdout.write("\n");
    return done ? "" : String(value).trim();
  };

  const present = agent.cli.present ?? presentAsJson;
  const approver: Approver = async (req) => {
    console.log(`\n\n${present(req)}`);
    const by = userInfo().username;
    for (;;) {
      const answer = await ask(
        `\n${dim("y approve · n reject · or type the change you want")}\n> `,
      );
      if (/^(y|yes)$/i.test(answer)) return { approved: true, by };
      if (/^(n|no)?$/i.test(answer)) {
        const reason = (await ask("Reason for rejecting: ")) || "no reason given";
        return { approved: false, by, reason };
      }
      const changes = answer.replace(/^change:\s*/i, "");
      if (changes) return { approved: false, by, changes };
      console.log("Type the change you want, or y to approve, n to reject.");
    }
  };

  let result: AgentResult;
  try {
    result = await agent.create(deps)({
      tenantId: tenant.id,
      // checked against the agent's own schema above, and again when the run starts
      input: parsed.data as never,
      approver,
      sinks: [{ write: show }],
    });
  } finally {
    lines.return?.();
    await deps.tracing?.shutdown();
    await deps.pool.end();
  }

  const failure = result.status === "failed" ? ` (${result.reason}: ${result.message})` : "";
  console.log(`\n${result.status}${failure}`);
  console.log(
    dim(
      `cost $${result.usage.costUsd.toFixed(4)} · ${result.usage.steps} steps · .runs/${result.runId}/events.jsonl`,
    ),
  );
  const note = agent.cli.done?.(result, tenant.id);
  if (note) console.log(dim(`· ${note}`));
  if (result.status === "rejected")
    console.log(dim("· the reason is saved to this tenant's memory"));
  if (result.afterRunError) console.error(`memory consolidation failed: ${result.afterRunError}`);
  return result.status === "failed" ? 1 : 0;
}

function show(e: RunEvent) {
  if (e.type === "token") process.stdout.write(e.data.text);
  else if (e.type === "context.built")
    console.log(
      dim(
        `· memory: ${e.data.sources.map((s) => s.kind).join(", ") || "none"} (${e.data.tokens} tokens)`,
      ),
    );
  else if (e.type === "tool.started") {
    const input = JSON.stringify(e.data.input);
    console.log(dim(`· ${e.data.tool}${input && input !== "{}" ? ` ${clip(input)}` : ""}`));
  } else if (e.type === "tool.denied")
    console.log(dim(`· denied ${e.data.tool}: ${e.data.reason}`));
  else if (e.type === "tool.completed" && !e.data.ok)
    console.log(dim(`· ${e.data.tool} failed: ${e.data.content}`));
  else if (e.type === "approval.changes_requested")
    console.log(dim(`· sent back for changes: ${e.data.changes}`));
}
