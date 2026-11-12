import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildRecord } from "@dugout/contracts";
import type { Grade } from "./graders.ts";
import type { JudgeVerdict } from "./judge.ts";

export type CaseKind = "standard" | "hard" | "redteam" | "memory";

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
  /** Model steps the run took, child runs included, where the suite counts them. */
  steps?: number;
  /** Questions the run put to a person (approvals of a write are not questions). */
  asked?: number;
  servedModels: string[];
  /** Set when the case could not run at all (e.g. no live model for a memory case). */
  skipped?: string;
}

export interface Attempt extends CaseOutcome {
  pass: boolean;
  error?: string;
}

export interface CaseResult {
  id: string;
  kind: CaseKind;
  tenant: string;
  attempts: Attempt[];
  passed: number;
  /** Every attempt passed. */
  pass: boolean;
  skipped?: string;
}

/** What a case cost on average over its attempts: the numbers memory is meant to lower (ADR 0034). */
export interface CaseEffort {
  attempts: number;
  steps: number | null;
  costUsd: number;
  asked: number | null;
}

/** The effort of each case that ran, averaged over the attempts that reported it. */
export function effortOf(results: CaseResult[]): Record<string, CaseEffort> {
  const mean = (values: number[]) =>
    values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
      : null;
  const out: Record<string, CaseEffort> = {};
  for (const r of results) {
    const ran = r.attempts.filter((a) => a.runIds.length > 0);
    if (ran.length === 0) continue;
    out[r.id] = {
      attempts: ran.length,
      steps: mean(ran.flatMap((a) => (a.steps === undefined ? [] : [a.steps]))),
      costUsd:
        Math.round((ran.reduce((sum, a) => sum + a.costUsd, 0) / ran.length) * 10000) / 10000,
      asked: mean(ran.flatMap((a) => (a.asked === undefined ? [] : [a.asked]))),
    };
  }
  return out;
}

/** Model steps in a run's stream: its own and, since a child's events are in it, its children's. */
export const stepsTaken = (events: Array<{ type: string }>): number =>
  events.filter((e) => e.type === "step.completed").length;

/** Questions a run asked a person, from its events: a pause with no call under review. */
export function questionsAsked(events: Array<{ type: string; data?: unknown }>): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "question.asked") continue;
    const data = e.data as { subject?: unknown; questions?: unknown[] };
    if (!data.subject) n += data.questions?.length ?? 0;
  }
  return n;
}

/** How a case's run treats memory (ADR 0034). */
export interface RunCaseOptions {
  /** Leave memory's record of the run (a build record, lessons), which evals leave out by default. */
  record?: boolean;
}

export interface EvalSuite<C extends EvalCase> {
  agentId: string;
  cases: C[];
  runCase(c: C, attempt: number, options?: RunCaseOptions): Promise<CaseOutcome>;
  /**
   * Makes the agent's own build record wrong in the way that would hurt (a hook that does not
   * exist, a container read as the wrong kind), for the wrong-record eval (ADR 0034).
   */
  plant?(record: BuildRecord): BuildRecord;
}

export interface RunSuiteOptions {
  concurrency: number;
  threshold: number;
  outDir: string;
  /** Times each case runs; model output varies, so one pass can be luck. */
  repeat?: number;
  only?: string[];
  onResult?: (r: CaseResult) => void;
}

export interface SuiteReport {
  agentId: string;
  startedAt: string;
  results: CaseResult[];
  summary: {
    cases: number;
    skipped: number;
    repeat: number;
    attempts: number;
    attemptsPassed: number;
    /** Share of graded attempts that passed; the gate is on this. */
    passRate: number;
    /** Cases that passed on every attempt. */
    consistentCases: number;
    threshold: number;
    gatePassed: boolean;
    costUsd: number;
    judgeAverage: number | null;
    servedModels: string[];
  };
  file: string;
}

/**
 * Runs every case `repeat` times. Standard, hard and red-team attempts run concurrently; memory
 * attempts run one at a time afterwards, because they change a tenant's memory and would leak into
 * attempts running beside them.
 */
export async function runSuite<C extends EvalCase>(
  suite: EvalSuite<C>,
  opts: RunSuiteOptions,
): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const repeat = Math.max(1, opts.repeat ?? 1);
  const selected = suite.cases.filter((c) => !opts.only || opts.only.includes(c.id));
  const attempts = new Map<string, Attempt[]>(selected.map((c) => [c.id, []]));
  const results: CaseResult[] = [];

  const finish = (c: C) => {
    const list = attempts.get(c.id) ?? [];
    const skipped = list.find((a) => a.skipped)?.skipped;
    const passed = list.filter((a) => a.pass).length;
    const result: CaseResult = {
      id: c.id,
      kind: c.kind,
      tenant: c.tenant,
      attempts: list,
      passed,
      pass: !skipped && passed === list.length,
      ...(skipped ? { skipped } : {}),
    };
    results.push(result);
    opts.onResult?.(result);
  };

  const runAttempt = async (c: C, n: number) => {
    let attempt: Attempt;
    try {
      const outcome = await suite.runCase(c, n);
      attempt = { ...outcome, pass: !outcome.skipped && outcome.grades.every((g) => g.pass) };
    } catch (err) {
      attempt = {
        pass: false,
        error: (err as Error).message,
        grades: [],
        runIds: [],
        costUsd: 0,
        servedModels: [],
      };
    }
    const list = attempts.get(c.id) ?? [];
    list.push(attempt);
    if (list.length === repeat) finish(c);
  };

  const jobs = selected
    .filter((c) => c.kind !== "memory")
    .flatMap((c) => Array.from({ length: repeat }, (_, n) => () => runAttempt(c, n)));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]?.();
    }),
  );
  for (const c of selected.filter((c) => c.kind === "memory")) {
    for (let n = 0; n < repeat; n++) await runAttempt(c, n);
  }

  const order = new Map(selected.map((c, i) => [c.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const graded = results.filter((r) => !r.skipped);
  const all = graded.flatMap((r) => r.attempts);
  const attemptsPassed = all.filter((a) => a.pass).length;
  const passRate = all.length ? attemptsPassed / all.length : 0;
  const judged = all.flatMap((a) => (a.judge ? [a.judge.score] : []));

  const file = join(opts.outDir, startedAt.replace(/[:.]/g, "-"), "results.json");
  const report: SuiteReport = {
    agentId: suite.agentId,
    startedAt,
    results,
    summary: {
      cases: results.length,
      skipped: results.length - graded.length,
      repeat,
      attempts: all.length,
      attemptsPassed,
      passRate,
      consistentCases: graded.filter((r) => r.pass).length,
      threshold: opts.threshold,
      // zero graded attempts is a failure, not a vacuous pass
      gatePassed: all.length > 0 && passRate >= opts.threshold,
      costUsd: results.flatMap((r) => r.attempts).reduce((sum, a) => sum + a.costUsd, 0),
      judgeAverage: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null,
      servedModels: [...new Set(results.flatMap((r) => r.attempts.flatMap((a) => a.servedModels)))],
    },
    file,
  };
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2));
  return report;
}
