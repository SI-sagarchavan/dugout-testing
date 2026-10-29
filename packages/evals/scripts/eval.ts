// pnpm eval <agent> [--scripted] [--fast] [--concurrency 8] [--threshold 0.9] [--only id,id]
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
    fast: { type: "boolean", default: false },
    concurrency: { type: "string", default: "8" },
    threshold: { type: "string", default: "0.9" },
    only: { type: "string" },
  },
});
const agent = positionals[0];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
  console.error("usage: pnpm eval <agent> [--scripted] [--fast] [--only id,id]");
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
  fast: values.fast,
  store,
  runsDir: join(REPO_ROOT, ".evals", "runs"),
});

const mark = (pass: boolean, skipped?: string) => (skipped ? "SKIP" : pass ? "PASS" : "FAIL");
const report = await runSuite(suite, {
  concurrency: Number(values.concurrency),
  threshold: Number(values.threshold),
  outDir: join(REPO_ROOT, ".evals"),
  ...(values.only ? { only: values.only.split(",") } : {}),
  onResult: (r) => {
    const failed = r.grades.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.detail}`);
    const judge = r.judge ? ` judge ${r.judge.score}/5` : "";
    console.log(`${mark(r.pass, r.skipped)} ${r.id}${judge}${r.error ? ` error: ${r.error}` : ""}`);
    for (const f of failed) console.log(`     ${f}`);
  },
});

const s = report.summary;
console.log(
  `\n${s.passed}/${s.graded} passed (${(s.passRate * 100).toFixed(0)}%, gate ${s.threshold * 100}%)` +
    `${s.skipped ? `, ${s.skipped} skipped` : ""} · judge avg ${s.judgeAverage?.toFixed(2) ?? "n/a"}` +
    ` · $${s.costUsd.toFixed(4)} · ${s.servedModels.join(", ")}`,
);
console.log(report.file);
await pool.end();
process.exitCode = s.gatePassed ? 0 : 1;
