import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Tenant = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string(),
  sport: z.string(),
});
export type Tenant = z.infer<typeof Tenant>;

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const DEFAULT_FILE = join(REPO_ROOT, "config", "tenants.json");
/**
 * Each demo tenant's own data, in `<tenant>/`: `facts.json`, the house facts `pnpm seed` starts
 * memory from, and the sample sports data that stands in for its feed.
 */
export const TENANTS_DIR = join(REPO_ROOT, "config", "tenants");

export interface TenantRegistry {
  list(): Tenant[];
  /** Returns the tenant, or throws: an unknown tenant never reaches a run. */
  require(id: string): Tenant;
}

export function loadTenants(file: string = DEFAULT_FILE): TenantRegistry {
  const tenants = z.array(Tenant).parse(JSON.parse(readFileSync(file, "utf8")));
  const byId = new Map(tenants.map((t) => [t.id, t]));
  return {
    list: () => [...tenants],
    require(id) {
      const tenant = byId.get(id);
      if (!tenant) throw new Error(`unknown tenant: ${id}`);
      return tenant;
    },
  };
}

/** Loads `.env` from the repo root into process.env, if present. Existing variables win. */
export function loadEnv(file: string = join(REPO_ROOT, ".env")): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
