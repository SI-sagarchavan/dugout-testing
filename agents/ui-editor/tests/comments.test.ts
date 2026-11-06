import { randomUUID } from "node:crypto";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { dbComments } from "../src/comments.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());

let a: string;
let b: string;
const ref = "4dd9e1cd-29e6-4236-901c-40a2721dbf95";
beforeEach(() => {
  const suffix = randomUUID().slice(0, 8);
  a = `t-a-${suffix}`;
  b = `t-b-${suffix}`;
});

const add = (tenant: string, body: string, over: { ref?: string; status?: string } = {}) =>
  withTenant(pool, tenant, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into ui_comments (tenant_id, project, ref, node_id, node_type, body, status, context)
       values ($1, 'default', $2, 'stack', 'Stack', $3, $4, $5) returning id`,
      [
        tenant,
        over.ref ?? ref,
        body,
        over.status ?? "open",
        JSON.stringify({ props: { gap: "space.2" } }),
      ],
    );
    return rows[0]?.id as string;
  });

describe("the comments of a tree", () => {
  it("are the tenant's own open ones on that tree, oldest first, with what the person had on screen", async () => {
    await add(a, "first");
    await add(a, "second");
    await add(a, "done already", { status: "done" });
    await add(a, "another tree", { ref: "other" });
    await add(b, "someone else's");

    const open = await dbComments(pool)(a, "default", ref).open();
    expect(open.map((c) => c.body)).toEqual(["first", "second"]);
    expect(open[0]).toMatchObject({
      nodeId: "stack",
      nodeType: "Stack",
      status: "open",
      context: { props: { gap: "space.2" } },
    });
    expect(await dbComments(pool)(b, "default", ref).open()).toHaveLength(1);
  });

  it("are marked sent with the run, for this tenant's tree only", async () => {
    const mine = await add(a, "mine");
    const theirs = await add(b, "theirs");

    await dbComments(pool)(a, "default", ref).sent([mine, theirs], "run-7");

    expect(await dbComments(pool)(a, "default", ref).open()).toEqual([]);
    const rows = await withTenant(
      pool,
      a,
      async (db) =>
        (
          await db.query<{ status: string; run_id: string | null }>(
            "select status, run_id from ui_comments where id = $1",
            [mine],
          )
        ).rows,
    );
    expect(rows).toEqual([{ status: "sent", run_id: "run-7" }]);
    // the other tenant's row is not visible to this one, so it cannot be touched
    expect((await dbComments(pool)(b, "default", ref).open()).map((c) => c.id)).toEqual([theirs]);
  });
});
