import { readFile } from "node:fs/promises";
import { join } from "node:path";

// the limits of the Agent Skills spec (agentskills.io)
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 1_024;

export interface Skill {
  name: string;
  /** From the file's frontmatter. Needed for a skill the agent loads on demand: it chooses by it. */
  description?: string;
  content: string;
  /** The file the content came from. */
  source: string;
}

/**
 * Procedural memory: `<dir>/<name>.md`, the same for every tenant, optionally starting with
 * frontmatter that has a `description:` line. What differs by tenant is in semantic memory (house
 * facts). Skills are git-versioned files; agents never write them.
 */
export async function loadSkill(dir: string, name: string): Promise<Skill> {
  if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name: ${name}`);
  const source = join(dir, `${name}.md`);
  const text = await readFile(source, "utf8").catch(() => undefined);
  if (text === undefined) throw new Error(`skill not found: ${source}`);
  const skill = parseSkill(text);
  if ((skill.description?.length ?? 0) > MAX_DESCRIPTION) {
    throw new Error(`${source}: description is over ${MAX_DESCRIPTION} characters`);
  }
  return { name, ...skill, source };
}

/** Splits a skill's frontmatter from its body. Only `description` is read from it. */
export function parseSkill(text: string): { description?: string; content: string } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!front) return { content: text.trim() };
  const description = /^description:\s*(.+)$/m.exec(front[1] ?? "")?.[1]?.trim();
  return { ...(description ? { description } : {}), content: text.slice(front[0].length).trim() };
}
