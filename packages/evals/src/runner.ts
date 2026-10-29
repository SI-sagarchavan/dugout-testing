import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Grade } from "./graders.ts";
import type { JudgeVerdict } from "./judge.ts";

export type CaseKind = "standard" | "redteam" | "memory";

export interface EvalCase {
  id: string;
  kind: CaseKind;
  tenant: string;
}

export interface CaseOutcome {
  grades: Grade[];
  judge?: JudgeVerdict;
  runIds: string[];
  costUsd: number;
  servedModels: string[];
  /** Set when the case could not run at all (e.g. no live model for a memory case). */
  skipped?: string;
}

export interface CaseResult extends CaseOutcome {
  id: string;
  kind: CaseKind;
  tenant: string;
  pass: boolean;
  error?: string;
}

export interface EvalSuite<C extends EvalCase> {
  agentId: string;
  cases: C[];
  runCase(c: C): Promise<CaseOutcome>;
}

export interface RunSuiteOptions {
  concurrency: number;
  threshold: number;
  outDir: string;
  only?: string[];
  onResult?: (r: CaseResult) => void;
}

export interface SuiteReport {
  agentId: string;
  startedAt: string;
  results: CaseResult[];
  summary: {
    cases: number;
    graded: number;
    passed: number;
    skipped: number;
    passRate: number;
    threshold: number;
    gatePassed: boolean;
    costUsd: number;
    judgeAverage: number | null;
    servedModels: string[];
  };
  file: string;
}

/**
 * Runs standard and red-team cases concurrently, then memory cases one at a time, because memory
 * cases change a tenant's memory and would leak into cases running beside them.
 */
export async function runSuite<C extends EvalCase>(
  suite: EvalSuite<C>,
  opts: RunSuiteOptions,
): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const selected = suite.cases.filter((c) => !opts.only || opts.only.includes(c.id));
  const results: CaseResult[] = [];

  const runOne = async (c: C): Promise<CaseResult> => {
    let result: CaseResult;
    try {
      const outcome = await suite.runCase(c);
      const pass = !outcome.skipped && outcome.grades.every((g) => g.pass);
      result = { id: c.id, kind: c.kind, tenant: c.tenant, pass, ...outcome };
    } catch (err) {
      result = {
        id: c.id,
        kind: c.kind,
        tenant: c.tenant,
        pass: false,
        error: (err as Error).message,
        grades: [],
        runIds: [],
        costUsd: 0,
        servedModels: [],
      };
    }
    results.push(result);
    opts.onResult?.(result);
    return result;
  };

  const parallel = selected.filter((c) => c.kind !== "memory");
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, parallel.length) }, async () => {
      while (next < parallel.length) {
        const c = parallel[next++];
        if (c) await runOne(c);
      }
    }),
  );
  for (const c of selected.filter((c) => c.kind === "memory")) await runOne(c);

  const order = new Map(selected.map((c, i) => [c.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const graded = results.filter((r) => !r.skipped);
  const passed = graded.filter((r) => r.pass).length;
  const passRate = graded.length ? passed / graded.length : 0;
  const judged = results.flatMap((r) => (r.judge ? [r.judge.score] : []));

  const file = join(opts.outDir, startedAt.replace(/[:.]/g, "-"), "results.json");
  const report: SuiteReport = {
    agentId: suite.agentId,
    startedAt,
    results,
    summary: {
      cases: results.length,
      graded: graded.length,
      passed,
      skipped: results.length - graded.length,
      passRate,
      threshold: opts.threshold,
      // zero graded cases is a failure, not a vacuous pass
      gatePassed: graded.length > 0 && passRate >= opts.threshold,
      costUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
      judgeAverage: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null,
      servedModels: [...new Set(results.flatMap((r) => r.servedModels))],
    },
    file,
  };
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2));
  return report;
}
