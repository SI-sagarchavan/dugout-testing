import type { Tenant } from "@dugout/core";
import {
  EFFORT_MARK,
  FAMILIES,
  loadModelConfig,
  loadTenants,
  modelEntry,
  modelFamily,
  runModel,
} from "@dugout/core";
import { agentIds, loadAgent } from "@dugout/sdk";
import { summaryOf } from "./commands.ts";
import type { InputField } from "./flags.ts";
import { inputFields } from "./flags.ts";
import type { Choice, Prompter } from "./ui.ts";

/** Select value that means "let me type this". It is never stored as input. */
export const TYPE_A_VALUE = "\u0000type";

export type Action = "run" | "attach" | "cancel" | "runs" | "history" | "fork" | "agents";

/** The home menu. Every row is a command from `pnpm agent --help`. */
export function pickAction(prompter: Prompter): Promise<Action> {
  return prompter.select("What do you want to do?", [
    { value: "run", label: "Run an agent", hint: "queue a run and follow it" },
    { value: "attach", label: "Attach to a run", hint: "follow one already queued" },
    { value: "cancel", label: "Cancel a run", hint: "stop a queued, running, or waiting run" },
    { value: "runs", label: "List recent runs", hint: "for one tenant" },
    { value: "history", label: "Show save points", hint: "every version of a run" },
    { value: "fork", label: "Fork a run", hint: "carry on from a save point" },
    { value: "agents", label: "List agents", hint: "what you can run" },
  ]) as Promise<Action>;
}

export async function pickAgent(prompter: Prompter): Promise<string> {
  const options: Choice[] = [];
  for (const id of await agentIds()) {
    const agent = await loadAgent(id);
    options.push({ value: id, label: id, hint: summaryOf(agent.spec.instructions) });
  }
  return prompter.select("Agent", options);
}

export function pickTenant(prompter: Prompter): Promise<string> {
  const options = loadTenants()
    .list()
    .map((tenant) => ({
      value: tenant.id,
      label: tenant.name,
      hint: `${tenant.id} · ${tenant.sports.join(", ")}`,
    }));
  return prompter.select("Tenant", options);
}

export interface RunChoice {
  id: string;
  agent_id: string;
  status: string;
  updated_at: Date;
}

export function chooseRun(
  prompter: Prompter,
  runs: readonly RunChoice[],
  message: string,
): Promise<string> {
  return prompter.select(
    message,
    runs.map((run) => ({
      value: run.id,
      label: `${run.agent_id}  ${run.status}`,
      hint: `${run.id.slice(0, 8)} · ${run.updated_at.toISOString().slice(0, 16).replace("T", " ")}`,
    })),
  );
}

/**
 * Fills input fields the command line left out. Required fields are asked one by one.
 * Optional fields are offered as a list, and only when `askOptional` is set, so a finished
 * command is not asked to confirm what it already said.
 */
export async function completeInput(opts: {
  agent: { input: Parameters<typeof inputFields>[0]; cli: { flags?: Record<string, string> } };
  given: Record<string, unknown>;
  askOptional: boolean;
  suggestions: (field: string) => readonly Choice[];
  prompter: Prompter;
}): Promise<Record<string, unknown>> {
  const fields = inputFields(opts.agent.input, opts.agent.cli.flags ?? {});
  const input: Record<string, unknown> = { ...opts.given };
  const missing = (required: boolean) =>
    fields.filter((field) => field.required === required && input[field.field] === undefined);

  for (const field of missing(true)) {
    input[field.field] = await askField(field, opts.suggestions(field.field), opts.prompter);
  }

  const optional = missing(false);
  if (opts.askOptional && optional.length > 0) {
    const chosen = await opts.prompter.multiselect(
      "Set anything else?",
      optional.map((field) => ({
        value: field.field,
        label: fieldLabel(field.field),
        ...(field.description ? { hint: field.description } : { hint: `--${field.flag}` }),
      })),
      false,
    );
    for (const name of chosen) {
      const field = optional.find((item) => item.field === name);
      if (!field) continue;
      input[field.field] = await askField(field, opts.suggestions(field.field), opts.prompter);
    }
  }
  return input;
}

async function askField(
  field: InputField,
  suggestions: readonly Choice[],
  prompter: Prompter,
): Promise<unknown> {
  const message = field.description ?? fieldLabel(field.field);
  if (field.kind === "boolean") return prompter.confirm(message, false);
  if (field.options?.length && field.kind === "string") {
    return prompter.select(
      message,
      field.options.map((value) => ({ value, label: value })),
    );
  }
  if (field.options?.length && field.kind === "strings") {
    return prompter.multiselect(
      message,
      field.options.map((value) => ({ value, label: value })),
      field.required,
    );
  }
  if (suggestions.length > 0 && field.kind === "string") {
    const picked = await prompter.select(message, [
      ...suggestions,
      { value: TYPE_A_VALUE, label: "Type a value" },
    ]);
    if (picked !== TYPE_A_VALUE) return picked;
    return prompter.text(message, { validate: requiredText });
  }
  if (suggestions.length > 0 && field.kind === "strings") {
    return prompter.multiselect(message, suggestions, field.required);
  }
  if (field.kind === "strings") {
    const raw = await prompter.text(message, { placeholder: "comma-separated" });
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (field.kind === "number") {
    const raw = await prompter.text(message, {
      validate: (value) =>
        value !== undefined && Number.isFinite(Number(value)) ? undefined : "Enter a number",
    });
    return Number(raw);
  }
  if (field.field === "brief") return prompter.multiline(message, { validate: requiredText });
  return prompter.text(message, field.required ? { validate: requiredText } : {});
}

function requiredText(value: string | undefined): string | undefined {
  return value?.trim() ? undefined : "Required";
}

export function fieldLabel(field: string): string {
  const words = field
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Values the prompts can offer without asking the model. Sports come from the tenant. */
export function fieldSuggestions(tenant: Tenant, field: string): Choice[] {
  if (field === "sports") return tenant.sports.map((sport) => ({ value: sport, label: sport }));
  return [];
}

/**
 * Which model, and how hard it thinks, when the terminal is asking. The first answer to each keeps
 * what the agent's spec says. Returns the name a run takes, or undefined for no change.
 */
export async function askModel(prompter: Prompter, specModel: string): Promise<string | undefined> {
  const config = loadModelConfig();
  const picked = await prompter.select("Model", [
    { value: "", label: `The agent's own (${specModel})` },
    ...Object.entries(config.models)
      .filter(([name]) => !name.includes(EFFORT_MARK))
      .map(([name, entry]) => ({
        value: name,
        label: name,
        hint: entry.effort ? `${entry.effort} effort` : "no effort setting",
      })),
  ]);
  const base = picked || specModel;
  const family = modelFamily(modelEntry(config, base).id);
  const efforts = family ? FAMILIES[family].efforts : [];
  const effort =
    efforts.length > 0
      ? await prompter.select("Effort", [
          { value: "", label: `${base}'s own (${config.models[base]?.effort ?? "none"})` },
          ...efforts.map((level) => ({ value: level, label: level })),
        ])
      : "";
  return runModel(config, specModel, { model: picked, effort });
}
