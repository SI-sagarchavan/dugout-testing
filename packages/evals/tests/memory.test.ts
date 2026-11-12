import { randomUUID } from "node:crypto";
import type { BuildRecord } from "@dugout/contracts";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, describe, expect, inject, it } from "vitest";
import { type CaseOutcome, type EvalCase, type EvalSuite, memoryEval } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

const record = (runId: string, did: unknown): BuildRecord => ({
  v: 1,
  agent: "fake",
  agentVersion: 1,
  section: { signature: "sig-1" },
  run: { runId, at: "2026-11-11T08:00:00Z" },
  did,
  outcome: {
    ended: "completed",
    good: true,
    remaining: [],
    steps: 5,
    costUsd: 0.2,
    asked: 1,
    approvedBy: "none",
  },
});

/** A suite whose second run is cheaper when it finds a record, and fails when it finds a wrong one. */
function fake(tenant: string, wrongBreaksIt: boolean): EvalSuite<EvalCase> {
  return {
    agentId: "fake",
    cases: [{ id: "case-1", kind: "standard", tenant }],
    plant: (r) => ({ ...r, did: { hook: "dugout_wrong" } }),
    async runCase(c, attempt, options): Promise<CaseOutcome> {
      const runId = randomUUID();
      if (options?.record) {
        await store.recordBuild({
          tenantId: c.tenant,
          agentId: "fake",
          record: record(runId, { hook: "dugout_right" }),
          content: "bound it",
          ttlDays: 1,
        });
        return {
          grades: [{ grader: "ok", pass: true, detail: "" }],
          runIds: [runId],
          costUsd: 0.2,
          steps: 5,
          asked: 1,
          servedModels: [],
        };
      }
      const seen = (await store.builds(c.tenant, { agentId: "fake" }))[0]?.value as
        | BuildRecord
        | undefined;
      const wrong = (seen?.did as { hook?: string } | undefined)?.hook === "dugout_wrong";
      const pass = !(wrong && wrongBreaksIt);
      return {
        grades: [{ grader: "ok", pass, detail: pass ? "" : "followed the wrong record" }],
        runIds: [runId],
        costUsd: seen ? 0.1 : 0.2,
        steps: seen ? 3 : 5,
        asked: seen ? 0 : 1,
        servedModels: [],
        _attempt: attempt,
      } as CaseOutcome;
    },
  };
}

describe("memory evals (ADR 0034)", () => {
  it("second sighting: reports what the record saved, and that the checks held", async () => {
    const tenant = `t-eval-${randomUUID().slice(0, 8)}`;
    const r = await memoryEval(
      fake(tenant, false),
      { id: "case-1", kind: "standard", tenant },
      { store, mode: "second" },
    );
    expect(r).toMatchObject({
      recorded: true,
      held: true,
      cold: { pass: true, steps: 5, asked: 1 },
      warm: { pass: true, steps: 3, asked: 0 },
      cheaper: { steps: -2, asked: -1 },
    });
    // what the runs wrote is gone
    expect(await store.builds(tenant)).toEqual([]);
  });

  it("wrong record: fails when the run follows it, passes when the checks decide", async () => {
    const tenant = `t-eval-${randomUUID().slice(0, 8)}`;
    const c = { id: "case-1", kind: "standard" as const, tenant };
    const followed = await memoryEval(fake(tenant, true), c, { store, mode: "wrong" });
    expect(followed).toMatchObject({ held: false });
    expect(followed.detail).toContain("followed the wrong record");
    const decided = await memoryEval(fake(tenant, false), c, { store, mode: "wrong" });
    expect(decided).toMatchObject({ held: true, detail: "the checks beat the planted record" });
    expect(await store.builds(tenant)).toEqual([]);
  });

  it("says so when the cold run left no record", async () => {
    const tenant = `t-eval-${randomUUID().slice(0, 8)}`;
    const suite = fake(tenant, false);
    const silent: EvalSuite<EvalCase> = {
      ...suite,
      runCase: async () => ({ grades: [], runIds: [randomUUID()], costUsd: 0, servedModels: [] }),
    };
    const r = await memoryEval(
      silent,
      { id: "case-1", kind: "standard", tenant },
      { store, mode: "second" },
    );
    expect(r).toMatchObject({ recorded: false, held: false });
  });
});
