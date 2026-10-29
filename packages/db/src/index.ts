import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/** Compose defaults (docker-compose.yml); override with DATABASE_URL / DATABASE_ADMIN_URL. */
export const LOCAL_APP_URL = "postgres://dugout_app:dugout_app@localhost:55432/harness";
export const LOCAL_ADMIN_URL = "postgres://harness:harness@localhost:55432/harness";

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL || LOCAL_APP_URL;
}

export function adminDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_ADMIN_URL || LOCAL_ADMIN_URL;
}

export function createPool(url: string = databaseUrl()): Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Runs `fn` in a transaction scoped to one tenant. Row-level security reads `app.tenant_id`, so a
 * query outside this helper sees no rows at all.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID.test(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/** Applies pending migrations in name order, each in its own transaction. Needs an admin URL. */
export async function migrate(adminUrl: string = adminDatabaseUrl()): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // serialise concurrent migrators (e.g. several test packages starting at once)
    await client.query("select pg_advisory_lock(7413)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const pending = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql") && !applied.has(f))
      .sort();
    for (const name of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${name} failed: ${(err as Error).message}`);
      }
    }
    return pending;
  } finally {
    await client.end();
  }
}

/** pgvector's text form. */
export const toVector = (values: number[]) => `[${values.join(",")}]`;
