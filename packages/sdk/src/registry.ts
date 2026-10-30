import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import type { AnyAgent } from "./agent.ts";

const AGENTS_DIR = join(REPO_ROOT, "agents");
const entry = (id: string) => join(AGENTS_DIR, id, "src", "index.ts");

/**
 * The agents in `agents/`, by the convention `pnpm eval` also uses: the folder name is the agent's
 * id and its `src/index.ts` exports `agent`. Dev tools (the terminal, seeding) find agents this
 * way; the worker lists the agents it runs explicitly.
 */
export async function agentIds(): Promise<string[]> {
  const dirs = await readdir(AGENTS_DIR, { withFileTypes: true });
  return dirs
    .filter((d) => d.isDirectory() && existsSync(entry(d.name)))
    .map((d) => d.name)
    .sort();
}

export async function loadAgent(id: string): Promise<AnyAgent> {
  if (!/^[a-z0-9-]+$/.test(id) || !existsSync(entry(id))) {
    throw new Error(`no agent "${id}" (agents: ${(await agentIds()).join(", ")})`);
  }
  const { agent } = (await import(entry(id))) as { agent?: AnyAgent };
  if (agent?.kind !== "agent" || agent.spec.id !== id) {
    throw new Error(`agents/${id}/src/index.ts must export \`agent\` from defineAgent, id "${id}"`);
  }
  return agent;
}
