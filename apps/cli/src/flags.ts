import { type ParseArgsConfig, parseArgs } from "node:util";
import type { AnyAgent } from "@dugout/sdk";
import { z } from "zod";

/** Flags the CLI takes itself; an input field with one of these names goes through `--input`. */
const RESERVED = new Set(["tenant", "input", "run", "after"]);

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

/** `--tenant`, `--input <json>` and the input's own flags, as the agent's raw input. */
export function parseCliArgs(agent: Pick<AnyAgent, "input" | "cli">, argv: string[]) {
  const flags = inputFlags(agent.input, agent.cli.flags);
  const options: NonNullable<ParseArgsConfig["options"]> = {
    tenant: { type: "string" },
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
  return { tenant: typeof values.tenant === "string" ? values.tenant : undefined, input };
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
  return [command, "--tenant <id>", ...parts, "[--input <json>]"].join(" ");
}
