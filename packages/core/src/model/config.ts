import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effort } from "@dugout/contracts";
import { z } from "zod";
import { REPO_ROOT } from "../tenants.ts";
import { ModelPrice } from "./pricing.ts";

/** Decides how effort, reasoning and cache points go over the wire. Read from the Bedrock id. */
export type ModelFamily = "claude" | "nova-2" | "nova";

export function modelFamily(id: string): ModelFamily | undefined {
  if (/(^|\.)anthropic\.claude-/.test(id)) return "claude";
  if (/(^|\.)amazon\.nova-2-/.test(id)) return "nova-2";
  if (/(^|\.)amazon\.nova-/.test(id)) return "nova";
  return undefined;
}

/** What each family takes, tried on si-main in ap-south-1 on 2026-10-30 (ADR 0015). */
export const FAMILIES: Record<ModelFamily, { efforts: readonly Effort[]; strictTools: boolean }> = {
  claude: { efforts: Effort.options, strictTools: true },
  "nova-2": { efforts: ["low", "medium", "high"], strictTools: false },
  nova: { efforts: [], strictTools: false },
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
          message: `${model.id} is of no known family (claude, nova-2, nova)`,
        });
        continue;
      }
      const { efforts, strictTools } = FAMILIES[family];
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

/** The entry a name stands for. */
export function modelEntry(config: ModelConfig, name: string): ModelEntry {
  const entry = config.models[name];
  if (!entry) {
    throw new Error(
      `no model named ${name}; the list has ${Object.keys(config.models).join(", ")}`,
    );
  }
  return entry;
}
