// pnpm agent memory answers --tenant sb — what people answered when a run asked (ADR 0029), the
// ones a run proposes the next time, and the ones it answers by itself. A person decides which:
//   (s)tanding: later runs stop asking this question and use the answer, saying so in the run;
//   (f)orget:   the answer is dropped, and nothing proposes it again;
//   Enter skips. Only a standing answer is ever used without asking.
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "../src/index.ts";

loadEnv();
const { values } = parseArgs({ options: { tenant: { type: "string" }, all: { type: "boolean" } } });
if (!values.tenant) {
  console.error("usage: pnpm agent memory answers --tenant <id> [--all]");
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const reviewer = userInfo().username;
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async () => {
  try {
    return (await rl.question("  (s)tanding, (f)orget, Enter to skip, (q)uit? "))
      .trim()
      .toLowerCase();
  } catch {
    return "q";
  }
};

const all = await store.listAnswers(tenant.id);
// by default what still needs a decision: not standing yet
const shown = values.all ? all : all.filter((a) => !a.standing);
if (shown.length === 0)
  console.log(`${tenant.id}: no learned answers${values.all ? "" : " to decide"}`);
for (const a of shown) {
  const answer = typeof a.answer === "string" ? a.answer : JSON.stringify(a.answer);
  console.log(`\n${a.question}`);
  console.log(
    `  ${answer}   (${a.kind}, ${a.times} time${a.times === 1 ? "" : "s"}, last ${a.lastAt.slice(0, 10)}${a.standing ? `, standing, approved by ${a.approvedBy}` : ""})`,
  );
  const reply = await ask();
  if (reply === "q") break;
  if (reply === "s") await store.makeStanding(tenant.id, a.id, reviewer);
  else if (reply === "f") await store.forgetAnswer(tenant.id, a.id);
}
await pool.end();
rl.close();
