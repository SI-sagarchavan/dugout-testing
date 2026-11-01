import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effort } from "@dugout/contracts";
import { z } from "zod";
import { REPO_ROOT } from "../tenants.ts";
import { ModelPrice } from "./pricing.ts";

/** Decides how effort, reasoning and cache points go over the wire. Read from the Bedrock id. */
export type ModelFamily = "claude" | "nova-2" | "nova" | "openai";

export function modelFamily(id: string): ModelFamily | undefined {
  if (/(^|\.)anthropic\.claude-/.test(id)) return "claude";
  if (/(^|\.)amazon\.nova-2-/.test(id)) return "nova-2";
  if (/(^|\.)amazon\.nova-/.test(id)) return "nova";
  if (/(^|\.)openai\.gpt-/.test(id)) return "openai";
  return undefined;
}

/** What each family takes, tried on si-main in ap-south-1 on 2026-10-30 (ADR 0015). */
export const FAMILIES: Record<
  ModelFamily,
  { efforts: readonly Effort[]; strictTools: boolean; forcedTools: boolean }
> = {
  claude: { efforts: Effort.options, strictTools: true, forcedTools: true },
  "nova-2": { efforts: ["low", "medium", "high"], strictTools: false, forcedTools: false },
  nova: { efforts: [], strictTools: false, forcedTools: false },
  // effort per the user, wire format untried on si-main; strict and forced tools unmeasured
  openai: { efforts: Effort.options, strictTools: false, forcedTools: false },
};

export const ModelEntry = z
  .object({
    /** The Bedrock id; ap-south-1 takes inference profiles only (`apac.*`, `global.*`, `in.*`). */
    id: z.string().min(1),
    effort: Effort.optional(),
    contextWindow: z.number().int().positive(),
    /** Sent as `maxTokens`: the reasoning and the reply share it. */
    maxOutputTokens: z.number().int().positive(),
    /** The model's tool arguments always match their schema. */
    strictTools: z.boolean().default(false),
    /** A request may force one tool (`toolChoice`); off where it conflicts with reasoning. */
    forcedTools: z.boolean().default(false),
    /** A failed tool result is sent with `status: "error"`; not every model takes the field. */
    toolErrorStatus: z.boolean().default(false),
    price: ModelPrice,
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntry>;

const ModelList = z
  .object({ $comment: z.string().optional(), models: z.record(z.string().min(1), ModelEntry) })
  .strict()
  .superRefine(({ models }, ctx) => {
    for (const [name, model] of Object.entries(models)) {
      const family = modelFamily(model.id);
      if (!family) {
        ctx.addIssue({
          code: "custom",
          path: ["models", name, "id"],
          message: `${model.id} is of no known family (claude, nova-2, nova, openai)`,
        });
        continue;
      }
      const { efforts, strictTools, forcedTools } = FAMILIES[family];
      if (model.effort && !efforts.includes(model.effort)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", name, "effort"],
          message: efforts.length
            ? `${family} models take ${efforts.join(", ")}`
            : `${family} models take no effort`,
        });
      }
      if (model.strictTools && !strictTools) {
        ctx.addIssue({
          code: "custom",
          path: ["models", name, "strictTools"],
          message: `${family} models don't take strict tools`,
        });
      }
      if (model.forcedTools && !forcedTools) {
        ctx.addIssue({
          code: "custom",
          path: ["models", name, "forcedTools"],
          message: `${family} models don't take a forced tool`,
        });
      }
    }
  });

/**
 * The models specs, tasks and judges name, by name (ADR 0015). The same model at two efforts is
 * two names, so a spec never carries a vendor setting.
 */
export interface ModelConfig {
  models: Record<string, ModelEntry>;
}

export const MODELS_FILE = join(REPO_ROOT, "config", "models.json");

/** Reads the model list and refuses an unknown family, an effort the family doesn't take or a missing price. */
export function loadModelConfig(file: string = MODELS_FILE): ModelConfig {
  return parseModelConfig(JSON.parse(readFileSync(file, "utf8")));
}

export function parseModelConfig(raw: unknown): ModelConfig {
  const parsed = ModelList.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid model list\n${z.prettifyError(parsed.error)}`);
  return { models: parsed.data.models };
}

/** Joins a model name and an effort: `sonnet@high`. A run names its model this way (see `modelEntry`). */
export const EFFORT_MARK = "@";

/**
 * The entry a name stands for. `base@effort` is the base entry at that effort, made when first
 * asked for and kept in the list, so a run can pick an effort without the list naming every pair
 * (ADR 0015 still holds: a spec names a model, and the effort is part of the name).
 */
export function modelEntry(config: ModelConfig, name: string): ModelEntry {
  const found = config.models[name];
  if (found) return found;
  const at = name.lastIndexOf(EFFORT_MARK);
  const base = at > 0 ? config.models[name.slice(0, at)] : undefined;
  if (base) {
    const effort = Effort.safeParse(name.slice(at + 1));
    if (!effort.success) {
      throw new Error(
        `${name.slice(at + 1)} is not an effort; efforts are ${Effort.options.join(", ")}`,
      );
    }
    const family = modelFamily(base.id);
    const takes = family ? FAMILIES[family].efforts : [];
    if (!takes.includes(effort.data)) {
      throw new Error(
        takes.length
          ? `${name.slice(0, at)} takes the efforts ${takes.join(", ")}, not ${effort.data}`
          : `${name.slice(0, at)} takes no effort`,
      );
    }
    const derived = { ...base, effort: effort.data };
    config.models[name] = derived;
    return derived;
  }
  throw new Error(`no model named ${name}; the list has ${Object.keys(config.models).join(", ")}`);
}

/**
 * The model name a run is asked to use: the model it names (else the agent's own), at the effort it
 * names, checked against the list. Undefined when it asks for neither, so the agent's spec decides.
 */
export function runModel(
  config: ModelConfig,
  specModel: string,
  ask: { model?: string | undefined; effort?: string | undefined },
): string | undefined {
  if (!ask.model && !ask.effort) return undefined;
  // an empty choice ("the agent's own") is no choice: `??` would keep the empty string
  const base = ask.model || specModel;
  const name = ask.effort ? `${base}${EFFORT_MARK}${ask.effort}` : base;
  modelEntry(config, name);
  return name;
}
