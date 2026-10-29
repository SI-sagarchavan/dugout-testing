import { readFile } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface Skill {
  name: string;
  content: string;
  /** Files the content came from, global first. */
  sources: string[];
}

/**
 * Procedural memory: `<dir>/<name>.md` is the global skill, and `<dir>/tenants/<tenant>/<name>.md`
 * is appended as that tenant's override. Skills are git-versioned files; agents never write them.
 */
export async function loadSkill(dir: string, name: string, tenantId: string): Promise<Skill> {
  if (!NAME.test(name)) throw new Error(`invalid skill name: ${name}`);
  if (!NAME.test(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`);
  const globalFile = join(dir, `${name}.md`);
  const tenantFile = join(dir, "tenants", tenantId, `${name}.md`);
  const global = await readFile(globalFile, "utf8").catch(() => undefined);
  if (global === undefined) throw new Error(`skill not found: ${globalFile}`);
  const override = await readFile(tenantFile, "utf8").catch(() => undefined);
  return {
    name,
    content: override
      ? `${global.trim()}\n\n### Tenant notes\n\n${override.trim()}`
      : global.trim(),
    sources: override ? [globalFile, tenantFile] : [globalFile],
  };
}
