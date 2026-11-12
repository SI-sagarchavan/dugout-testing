import { randomUUID } from "node:crypto";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { dbComments } from "../src/comments.ts";
import { dbVersions } from "../src/versions.ts";

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

const add = (
  tenant: string,
  body: string,
  over: { ref?: string; status?: string; node?: string; section?: string } = {},
) =>
  withTenant(pool, tenant, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into ui_comments (tenant_id, project, ref, node_id, node_type, body, status, context,
         section_run_id)
       values ($1, 'default', $2, $6, 'Stack', $3, $4, $5, $7) returning id`,
      [
        tenant,
        over.ref ?? ref,
        body,
        over.status ?? "open",
        JSON.stringify({ props: { gap: "space.2" } }),
        over.node ?? "stack",
        over.section ?? null,
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

  it("are the ones a host handed to the run, when it handed any", async () => {
    await add(a, "still open");
    const handed = await add(a, "sent with the run", { status: "sent" });
    await withTenant(pool, a, (db) =>
      db.query("update ui_comments set run_id = 'run-9' where id = $1", [handed]),
    );

    const source = dbComments(pool)(a, "default", ref);
    expect((await source.open("run-9")).map((c) => c.body)).toEqual(["sent with the run"]);
    // the terminal hands none: the run takes the open ones
    expect((await source.open("run-other")).map((c) => c.body)).toEqual(["still open"]);
  });

  it("are the ones named, when the host names them, and earlier ones on the same element", async () => {
    const named = await add(a, "named", { status: "sent", section: "sec-1" });
    await add(a, "open too", { section: "sec-1" });
    await add(a, "before, on the tree an earlier edit made", {
      ref: "older-tree",
      status: "done",
      section: "sec-1",
    });
    await add(a, "before, on another element", { node: "other", status: "done", section: "sec-1" });
    const source = dbComments(pool)(a, "default", ref, "sec-1");
    expect((await source.open("run-x", [named])).map((c) => c.body)).toEqual(["named"]);
    // a section's comments outlive each tree: an earlier one on another tree of it is found
    const earlier = await source.earlier?.(["stack"], [named]);
    expect(earlier?.map((e) => e.body)).toEqual([
      "before, on the tree an earlier edit made",
      "open too",
    ]);
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

describe("a section's versions", () => {
  it("are kept in the thread of the run that built the section", async () => {
    const section = randomUUID();
    await withTenant(pool, a, (db) =>
      db.query(
        "insert into runs (id, tenant_id, agent_id, status, input) values ($1, $2, 'section-builder', 'completed', '{}')",
        [section, a],
      ),
    );
    await dbVersions(pool).add(a, {
      section,
      project: "default",
      tree: "t2",
      plan: "p1",
      preview: "http://x/preview/default/t2?plan=p1",
      fromTree: "t1",
      runId: "run-1",
      what: "row gap",
    });
    const rows = await withTenant(
      pool,
      a,
      async (db) =>
        (
          await db.query<{ tree: string; by: string; same: boolean }>(
            `select v.tree, v.by, v.thread_id = r.thread_id as same
             from section_versions v join runs r on r.id = v.section_run_id`,
          )
        ).rows,
    );
    expect(rows).toEqual([{ tree: "t2", by: "agent:ui-editor", same: true }]);
  });
});
