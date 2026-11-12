// pnpm eval <agent> [--live] [--scripted] [--model <name>] [--repeat 3] [--concurrency 8] [--threshold 0.9] [--only id,id] [--cold]
// --cold writes each case's steps, cost and questions, with nothing in memory, to
// agents/<agent>/evals/cold-baseline.json: what a run with memory is measured against (ADR 0034).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, REPO_ROOT } from "@dugout/core";
import { createPool } from "@dugout/db";
import { prepareDatabase, resetDatabase } from "@dugout/db/testing";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { type EvalCase, type EvalSuite, effortOf, memoryEval, runSuite } from "../src/index.ts";

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
    cold: { type: "boolean", default: false },
    // second: each case cold, then with its record; wrong: then with a wrong record (ADR 0034)
    memory: { type: "string" },
  },
});
const agent = positionals[0];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
  console.error("usage: pnpm eval <agent> [--scripted] [--model <name>] [--only id,id]");
  process.exit(2);
}

// A throwaway database, emptied and re-seeded every run, so results don't depend on dev memory.
// One per agent: two suites run at once never empty each other's runs.
const { appUrl, adminUrl } = await prepareDatabase(`harness_eval_${agent.replace(/[^a-z]/g, "_")}`);
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

// ADR 0034: does a record help (second) and do the checks beat a wrong one (wrong)
if (values.memory) {
  if (values.memory !== "second" && values.memory !== "wrong") {
    console.error("--memory takes second or wrong");
    process.exit(2);
  }
  if (values.scripted) throw new Error("--memory needs live runs: a script learns nothing");
  const only = values.only?.split(",");
  let failed = 0;
  const signed = (n: number | null) => (n === null ? "?" : `${n > 0 ? "+" : ""}${n}`);
  for (const c of suite.cases.filter((c) => !only || only.includes(c.id))) {
    const r = await memoryEval(suite, c, { store, mode: values.memory });
    if (!r.held) failed++;
    const warm = values.memory === "wrong" ? "a wrong record" : "its record";
    console.log(
      `${r.held ? "PASS" : "FAIL"} ${r.id} · cold ${r.cold.steps ?? "?"} steps $${r.cold.costUsd.toFixed(3)} ${r.cold.asked ?? "?"} asked → with ${warm} ${r.warm.steps ?? "?"} steps $${r.warm.costUsd.toFixed(3)} ${r.warm.asked ?? "?"} asked (${signed(r.cheaper.steps)} steps, ${signed(r.cheaper.costUsd)} $, ${signed(r.cheaper.asked)} asked) · ${r.detail}`,
    );
  }
  await pool.end();
  process.exit(failed ? 1 : 0);
}

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
    const e = effortOf([r])[r.id];
    const effort = e
      ? ` · ${e.steps ?? "?"} steps, $${e.costUsd.toFixed(3)}, ${e.asked ?? "?"} asked`
      : "";
    console.log(`${status} ${r.passed}/${r.attempts.length} ${r.id}${judge}${effort}`);
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
if (values.cold) {
  if (values.scripted)
    throw new Error("--cold needs live runs: a scripted run has no steps or cost");
  const file = join(REPO_ROOT, "agents", agent, "evals", "cold-baseline.json");
  const cold = {
    recordedAt: report.startedAt,
    note: "steps, cost and questions per case with nothing in memory, averaged over the attempts",
    models: s.servedModels,
    ...(values.model ? { model: values.model } : {}),
    repeat,
    cases: effortOf(report.results),
  };
  writeFileSync(file, `${JSON.stringify(cold, null, 2)}\n`);
  console.log(file);
}
await pool.end();
// the report is written: open clients (an MCP session, a render browser) must not keep the run alive
process.exit(s.gatePassed ? 0 : 1);
