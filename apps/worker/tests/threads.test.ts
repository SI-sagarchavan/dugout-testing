import { randomUUID } from "node:crypto";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { Valkey } from "iovalkey";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createRunQueue, createValkeyEventLog } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
const valkey = new Valkey(process.env.VALKEY_TEST_URL || "redis://localhost:56379/1");
const queue = createRunQueue({ pool, events: createValkeyEventLog(valkey) });
const TENANT = "demo-cricket";
afterAll(async () => {
  await pool.end();
  valkey.disconnect();
});

const row = (runId: string) =>
  withTenant(pool, TENANT, async (db) => {
    const { rows } = await db.query(
      "select r.thread_id, t.subject from runs r join threads t on t.id = r.thread_id where r.id = $1",
      [runId],
    );
    return rows[0] as { thread_id: string; subject: unknown };
  });
const complete = (runId: string, output: object = {}) =>
  withTenant(pool, TENANT, (db) =>
    db.query("update runs set status = 'completed', result = $2 where id = $1", [
      runId,
      { output },
    ]),
  );

describe("threads (migration 019)", () => {
  it("a Handoff starts a thread, and every later run about that section joins it", async () => {
    const handoffId = randomUUID();
    const tree = randomUUID();
    const preview = `http://localhost:3000/preview/default/${tree}?theme=t`;

    const builder = await queue.start(TENANT, "section-builder", { handoffId });
    const thread = await row(builder);
    expect(thread.subject).toEqual({ handoffId });

    // a child run is in its parent's thread
    const child = randomUUID();
    await withTenant(pool, TENANT, (db) =>
      db.query(
        `insert into runs (id, tenant_id, agent_id, status, input, parent_run_id, parent_call_id)
         values ($1, $2, 'frame-match', 'running', $3, $4, 'call_1')`,
        [child, TENANT, { handoffId }, builder],
      ),
    );
    expect((await row(child)).thread_id).toBe(thread.thread_id);

    // the comments sent on the section: the host names the section's thread
    await complete(builder, { previewUrl: preview });
    const editor = await queue.start(
      TENANT,
      "ui-editor",
      { preview: `${preview}&data=d` },
      { threadId: thread.thread_id },
    );
    expect((await row(editor)).thread_id).toBe(thread.thread_id);
    // and so does a follow-up of that one
    await complete(editor, { previewUrl: `http://localhost:3000/preview/default/${randomUUID()}` });
    const followUp = await queue.continueFrom(TENANT, editor, { comments: [] });
    expect((await row(followUp)).thread_id).toBe(thread.thread_id);
    // or one a host puts there by name
    const named = await queue.start(
      TENANT,
      "data-bind",
      { other: true },
      {
        threadId: thread.thread_id,
      },
    );
    expect((await row(named)).thread_id).toBe(thread.thread_id);

    const runs = await queue.thread(TENANT, thread.thread_id);
    expect(runs.map((r) => r.id)).toEqual([builder, child, editor, followUp, named]);
    // invocations are the runs no call started
    expect(runs.filter((r) => !r.parent_call_id).map((r) => r.agent_id)).toEqual([
      "section-builder",
      "ui-editor",
      "ui-editor",
      "data-bind",
    ]);
  });

  it("another Handoff, or a run on a preview with no thread named, starts a thread of its own: a thread is named, never guessed from a link", async () => {
    const a = await queue.start(TENANT, "section-builder", { handoffId: randomUUID() });
    const b = await queue.start(TENANT, "section-builder", { handoffId: randomUUID() });
    const tree = randomUUID();
    await complete(a, { previewUrl: `http://localhost:3000/preview/default/${tree}` });
    const c = await queue.start(TENANT, "ui-editor", {
      preview: `http://localhost:3000/preview/default/${tree}`,
    });
    const threads = new Set([
      (await row(a)).thread_id,
      (await row(b)).thread_id,
      (await row(c)).thread_id,
    ]);
    expect(threads.size).toBe(3);
  });

  it("refuses a thread the tenant does not have", async () => {
    const mine = await queue.start(TENANT, "section-builder", { handoffId: randomUUID() });
    const { thread_id } = await row(mine);
    await expect(
      queue.start("demo-football", "section-builder", {}, { threadId: thread_id }),
    ).rejects.toThrow(/no thread/);
  });
});
