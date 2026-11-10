// pnpm eval <agent> [--live] [--scripted] [--model <name>] [--repeat 3] [--concurrency 8] [--threshold 0.9] [--only id,id]
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, REPO_ROOT } from "@dugout/core";
import { createPool } from "@dugout/db";
import { prepareDatabase, resetDatabase } from "@dugout/db/testing";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { type EvalCase, type EvalSuite, runSuite } from "../src/index.ts";

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scripted: { type: "boolean", default: false },
    model: { type: "string" },
    repeat: { type: "string" },
    concurrency: { type: "string", default: "8" },
    threshold: { type: "string", default: "0.9" },
    only: { type: "string" },
    // `pnpm eval data`: call Cast for real; otherwise a case reuses its cached hook output
    live: { type: "boolean", default: false },
  },
});
const agent = positionals[0];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
  console.error("usage: pnpm eval <agent> [--scripted] [--model <name>] [--only id,id]");
  process.exit(2);
}

// A throwaway database, emptied and re-seeded every run, so results don't depend on dev memory.
const { appUrl, adminUrl } = await prepareDatabase("harness_eval");
await resetDatabase(adminUrl);
const pool = createPool(appUrl);
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });

const mod = (await import(join(REPO_ROOT, "agents", agent, "evals", "suite.ts"))) as {
  createSuite(opts: unknown): Promise<EvalSuite<EvalCase>>;
};
const suite = await mod.createSuite({
  mode: values.scripted ? "scripted" : "live",
  ...(values.model ? { model: values.model } : {}),
  store,
  runsDir: join(REPO_ROOT, ".evals", "runs"),
  live: values.live,
});

// the scripted model gives the same answer every time, so repeating it proves nothing
const repeat = Number(values.repeat ?? (values.scripted ? 1 : 3));
const report = await runSuite(suite, {
  concurrency: Number(values.concurrency),
  threshold: Number(values.threshold),
  outDir: join(REPO_ROOT, ".evals"),
  repeat,
  ...(values.only ? { only: values.only.split(",") } : {}),
  onResult: (r) => {
    const status = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
    const scores = r.attempts.flatMap((a) => (a.judge ? [a.judge.score] : []));
    const judge = scores.length ? ` judge ${scores.join(",")}` : "";
    console.log(`${status} ${r.passed}/${r.attempts.length} ${r.id}${judge}`);
    if (r.skipped) console.log(`     ${r.skipped}`);
    const failures = new Set(
      r.attempts.flatMap((a) => [
        ...(a.error ? [`error: ${a.error}`] : []),
        ...a.grades.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.detail}`),
      ]),
    );
    for (const f of failures) console.log(`     ${f}`);
  },
});

const s = report.summary;
console.log(
  `\n${s.attemptsPassed}/${s.attempts} attempts passed (${(s.passRate * 100).toFixed(0)}%, gate ${s.threshold * 100}%)` +
    ` · ${s.consistentCases}/${s.cases - s.skipped} cases passed every attempt` +
    `${s.skipped ? ` · ${s.skipped} skipped` : ""} · judge avg ${s.judgeAverage?.toFixed(2) ?? "n/a"}` +
    ` · $${s.costUsd.toFixed(4)} · ${s.servedModels.join(", ")}`,
);
console.log(report.file);
await pool.end();
process.exitCode = s.gatePassed ? 0 : 1;
