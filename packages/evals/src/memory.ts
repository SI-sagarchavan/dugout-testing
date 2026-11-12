import type { BuildRecord } from "@dugout/contracts";
import type { MemoryStore } from "@dugout/memory";
import type { CaseOutcome, EvalCase, EvalSuite } from "./runner.ts";

/**
 * The evals that say whether build records help (ADR 0034, section 11). Each runs a case cold,
 * leaving its record, then again with that record in memory:
 *
 * - **second sighting**: the second run must pass whenever the cold one did, and its steps, cost
 *   and questions are reported against the first. The ADR's claim is that they fall.
 * - **a wrong record**: the record is replaced by one that is wrong (`plant` makes it), and the
 *   run must still pass: the checks decide, not the record.
 *
 * Abstention (a good record of an unlike section is not shown) needs no model and is tested in
 * `packages/memory/tests/builds.test.ts`.
 */
export type MemoryEvalMode = "second" | "wrong";

export interface Effort {
  pass: boolean;
  steps: number | null;
  costUsd: number;
  asked: number | null;
  error?: string;
}

export interface MemoryEvalResult {
  id: string;
  mode: MemoryEvalMode;
  cold: Effort;
  warm: Effort;
  /** Whether a record was left for the second run to read. */
  recorded: boolean;
  /** The checks held: the second run passed wherever the cold run did. */
  held: boolean;
  /** Fewer steps, less cost or fewer questions than cold (second sighting only). */
  cheaper: { steps: number | null; costUsd: number; asked: number | null };
  detail: string;
}

const effort = (o: CaseOutcome | undefined, error?: string): Effort => ({
  pass: !!o && !o.skipped && o.grades.every((g) => g.pass),
  steps: o?.steps ?? null,
  costUsd: o?.costUsd ?? 0,
  asked: o?.asked ?? null,
  ...(error ? { error } : {}),
});

const delta = (cold: number | null, warm: number | null) =>
  cold === null || warm === null ? null : Math.round((warm - cold) * 10_000) / 10_000;

export async function memoryEval<C extends EvalCase>(
  suite: EvalSuite<C>,
  c: C,
  deps: { store: MemoryStore; mode: MemoryEvalMode },
): Promise<MemoryEvalResult> {
  const { store, mode } = deps;
  const base = { id: c.id, mode };
  const empty = { steps: null, costUsd: 0, asked: null };
  const runIds: string[] = [];
  try {
    const cold = await suite.runCase(c, 0, { record: true });
    runIds.push(...cold.runIds);
    if (cold.skipped) {
      return {
        ...base,
        cold: effort(cold),
        warm: effort(undefined),
        recorded: false,
        held: true,
        cheaper: empty,
        detail: `skipped: ${cold.skipped}`,
      };
    }
    const records = await store.builds(c.tenant, { agentId: suite.agentId, limit: 20 });
    const latest = records.find(
      (r) => (r.value as BuildRecord | null)?.run.runId === cold.runIds[0],
    );
    if (!latest) {
      return {
        ...base,
        cold: effort(cold),
        warm: effort(undefined),
        recorded: false,
        held: false,
        cheaper: empty,
        detail: "the cold run left no build record, so there is nothing for a second run to read",
      };
    }
    if (mode === "wrong") {
      if (!suite.plant) throw new Error(`${suite.agentId} has no way to plant a wrong record`);
      const record = latest.value as BuildRecord;
      const wrong = suite.plant(record);
      await store.recordBuild({
        tenantId: c.tenant,
        agentId: suite.agentId,
        record: { ...wrong, run: { ...wrong.run, runId: `planted-${record.run.runId}` } },
        content: `${latest.content} (planted wrong)`,
        ttlDays: 1,
      });
    }
    const warm = await suite.runCase(c, 1);
    runIds.push(...warm.runIds);
    const w = effort(warm);
    const k = effort(cold);
    const held = !k.pass || w.pass;
    const cheaper = {
      steps: delta(k.steps, w.steps),
      costUsd: delta(k.costUsd, w.costUsd) ?? 0,
      asked: delta(k.asked, w.asked),
    };
    return {
      ...base,
      cold: k,
      warm: w,
      recorded: true,
      held,
      cheaper,
      detail: held
        ? mode === "wrong"
          ? "the checks beat the planted record"
          : "the second run held"
        : `the second run failed where the cold one passed: ${warm.grades
            .filter((g) => !g.pass)
            .map((g) => `${g.grader}: ${g.detail}`)
            .join("; ")}`,
    };
  } catch (err) {
    return {
      ...base,
      cold: effort(undefined, (err as Error).message),
      warm: effort(undefined),
      recorded: false,
      held: false,
      cheaper: empty,
      detail: (err as Error).message,
    };
  } finally {
    // what the runs wrote is only for this comparison
    for (const runId of runIds) await store.deleteBySourceRun(c.tenant, runId).catch(() => 0);
    await store.deleteBySourceRun(c.tenant, `planted-${runIds[0] ?? ""}`).catch(() => 0);
  }
}
