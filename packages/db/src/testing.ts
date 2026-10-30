import pg from "pg";
import { adminDatabaseUrl, migrate } from "./index.ts";

const TEST_DB = "harness_test";

/**
 * Creates and migrates a database next to the main one (default `harness_test`) and returns its
 * app-role and admin URLs. Needs `pnpm infra:up` locally; CI provides a service.
 */
export async function prepareDatabase(
  name = TEST_DB,
): Promise<{ appUrl: string; adminUrl: string }> {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`invalid database name: ${name}`);
  const admin = new URL(adminDatabaseUrl());
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `cannot reach Postgres at ${admin.host} (${(err as Error).message}); run \`pnpm infra:up\``,
    );
  }
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    // concurrent globalSetups (one per package) can race here
    if (!rowCount) await client.query(`create database ${name}`).catch(() => {});
  } finally {
    await client.end();
  }

  const adminUrl = new URL(admin);
  adminUrl.pathname = `/${name}`;
  await migrate(adminUrl.toString());
  const appUrl = new URL(adminUrl);
  appUrl.username = "dugout_app";
  appUrl.password = "dugout_app";
  return { appUrl: appUrl.toString(), adminUrl: adminUrl.toString() };
}

/**
 * A vitest globalSetup with a database of its own, emptied first: for tests that run workers, which
 * would otherwise claim the runs other packages' tests queue. Tests read `inject("databaseUrl")`.
 */
export function ownDatabaseSetup(name: string) {
  return async ({
    provide,
  }: {
    provide: (key: "databaseUrl" | "adminDatabaseUrl", value: string) => void;
  }) => {
    const { appUrl, adminUrl } = await prepareDatabase(name);
    await resetDatabase(adminUrl);
    provide("databaseUrl", appUrl);
    provide("adminDatabaseUrl", adminUrl);
  };
}

/** Empties runs, events and memory. Admin only; for throwaway databases such as the eval one. */
export async function resetDatabase(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("truncate runs, run_events, run_messages, run_checkpoints, memory_items");
  } finally {
    await client.end();
  }
}
