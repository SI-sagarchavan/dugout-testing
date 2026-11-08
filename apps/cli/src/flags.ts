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

/** One input field, named the way the command line and the prompts show it. */
export interface InputField extends InputFlag {
  /** The name used in help. The last alias, or the field name when it has none. */
  flag: string;
  /** Every command-line name: the field, then its aliases. */
  names: readonly string[];
  description?: string;
  /** Set when the field is an enum, or a list of one. The prompts offer these. */
  options?: readonly string[];
}

/**
 * The command-line flags for an input schema: one per top-level field of a plain type (string,
 * enum, number, boolean, or a list of strings), under its own name and any alias. Other fields
 * can still be given in `--input '<json>'`.
 */
export function inputFlags(schema: z.ZodType, aliases: Record<string, string> = {}) {
  const flags = new Map<string, InputFlag>();
  for (const field of inputFields(schema, aliases)) {
    const flag: InputFlag = { field: field.field, kind: field.kind, required: field.required };
    for (const name of field.names) flags.set(name, flag);
  }
  return flags;
}

/** One entry per input field, with the description and enum options a prompt or a help screen uses. */
export function inputFields(schema: z.ZodType, aliases: Record<string, string> = {}): InputField[] {
  const aliasNames = new Map<string, string[]>();
  for (const [alias, field] of Object.entries(aliases)) {
    if (RESERVED.has(alias) || RESERVED.has(field)) continue;
    const names = aliasNames.get(field) ?? [];
    names.push(alias);
    aliasNames.set(field, names);
  }
  if (!(schema instanceof z.ZodObject)) return [];
  const fields: InputField[] = [];
  for (const [field, type] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    if (RESERVED.has(field)) continue;
    const { inner, required, description } = unwrap(type);
    const kind = kindOf(inner);
    if (!kind) continue;
    const names = [field, ...(aliasNames.get(field) ?? [])];
    const options = optionsOf(inner);
    fields.push({
      field,
      flag: names.at(-1) ?? field,
      names,
      kind,
      required,
      ...(description ? { description } : {}),
      ...(options ? { options } : {}),
    });
  }
  return fields;
}

/** Walks optional and default wrappers. A default makes the field optional on the command line. */
function unwrap(type: z.ZodType) {
  let inner = type;
  let required = true;
  let description = described(type);
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
    required = false;
    description = description ?? described(inner);
    inner = inner.unwrap() as z.ZodType;
  }
  return { inner, required, description: description ?? described(inner) };
}

function described(type: z.ZodType): string | undefined {
  const description = type.description;
  return typeof description === "string" && description.trim() ? description : undefined;
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

function optionsOf(type: z.ZodType): string[] | undefined {
  if (type instanceof z.ZodEnum) return type.options.map(String);
  if (type instanceof z.ZodArray) {
    const element = type.element as z.ZodType;
    if (element instanceof z.ZodEnum) return element.options.map(String);
  }
  return undefined;
}

/** `--tenant`, `--input <json>` and the input's own flags, as the agent's raw input. */
export function parseCliArgs(agent: Pick<AnyAgent, "input" | "cli">, argv: string[]) {
  const flags = inputFlags(agent.input, agent.cli.flags);
  const options: NonNullable<ParseArgsConfig["options"]> = {
    tenant: { type: "string" },
    input: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    yes: { type: "boolean" },
    thread: { type: "string" },
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
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    tenant: text(values.tenant),
    input,
    model: text(values.model),
    effort: text(values.effort),
    yes: values.yes === true,
    /** The thread the run joins (ADR 0031); left out, it starts one. */
    thread: text(values.thread),
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
  return [
    command,
    "--tenant <id>",
    ...parts,
    "[--input <json>]",
    "[--model <name>] [--effort <level>] [--yes]",
  ].join(" ");
}
