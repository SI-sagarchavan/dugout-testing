import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createPool, withTenant } from "../src/index.ts";
import type {} from "../src/vitest-setup.ts"; // types for inject()

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());

const insertRun = (tenantId: string, id = randomUUID()) =>
  withTenant(pool, tenantId, async (db) => {
    await db.query(
      "insert into runs (id, tenant_id, agent_id, status, input) values ($1, $2, 'a', 'running', '{}')",
      [id, tenantId],
    );
    return id;
  });

describe("row-level security", () => {
  it("shows a tenant only its own rows, including by id", async () => {
    const id = await insertRun("rls-a");
    const own = await withTenant(pool, "rls-a", (db) =>
      db.query("select id from runs where id = $1", [id]),
    );
    const other = await withTenant(pool, "rls-b", (db) =>
      db.query("select id from runs where id = $1", [id]),
    );
    expect(own.rowCount).toBe(1);
    expect(other.rowCount).toBe(0);
  });

  it("returns nothing when no tenant is set", async () => {
    await insertRun("rls-a");
    const { rowCount } = await pool.query("select id from runs");
    expect(rowCount).toBe(0);
  });

  it("refuses to write a row for another tenant", async () => {
    await expect(
      withTenant(pool, "rls-a", (db) =>
        db.query(
          "insert into runs (id, tenant_id, agent_id, status, input) values ($1, 'rls-b', 'a', 'running', '{}')",
          [randomUUID()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects malformed tenant ids before touching the database", async () => {
    await expect(withTenant(pool, "x' or 1=1 --", async () => 1)).rejects.toThrow("invalid tenant");
  });
});
