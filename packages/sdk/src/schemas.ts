import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import { z } from "zod";
import type { AnyAgent } from "./agent.ts";
import { agentIds, loadAgent } from "./registry.ts";

/** Where `pnpm agent schemas` writes them; hosts copy them from here. */
export const SCHEMAS_DIR = join(REPO_ROOT, "schemas");

/**
 * An agent's input, and its output when it has one, as JSON Schema: what a host (the plugin,
 * Studio, wnm-fanxp-backend) checks a request against before queueing a run, and the shape of the
 * result, without importing our code.
 */
export function agentSchemas(agent: Pick<AnyAgent, "input" | "definition">) {
  // what the host gets back, which is not always what the model sends to `final`
  const output = agent.definition.result ?? agent.definition.output;
  return {
    input: z.toJSONSchema(agent.input, { io: "input" }),
    ...(output ? { output: z.toJSONSchema(output, { io: "output" }) } : {}),
  };
}

/** Every agent's schema files, by file name: `<agent>.input.json`, `<agent>.output.json`. */
export async function schemaFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const id of await agentIds()) {
    const schemas = agentSchemas(await loadAgent(id));
    for (const [kind, schema] of Object.entries(schemas)) {
      files[`${id}.${kind}.json`] = `${JSON.stringify(schema, null, 2)}\n`;
    }
  }
  return files;
}
