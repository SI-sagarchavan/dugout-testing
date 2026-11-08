// pnpm agent memory decisions --tenant sb [--section <signature>] — what people decided about one
// section when a run asked (ADR 0033): the latest answer to each question, newest first. A later run
// on the same section is proposed it, and frame.load and bind.load show it to the agent.
//   (f)orget: the decision is dropped, and the question is asked as if it never was;
//   Enter skips. --list prints them without asking.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { answerText, createMemoryStore, loadEmbeddings } from "../src/index.ts";

loadEnv();
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    section: { type: "string" },
    list: { type: "boolean" },
  },
});
if (!values.tenant) {
  console.error(
    "usage: pnpm agent memory decisions --tenant <id> [--section <signature>] [--list]",
  );
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const rl = values.list
  ? undefined
  : createInterface({ input: process.stdin, output: process.stdout });
const ask = async () => {
  try {
    return ((await rl?.question("  (f)orget, Enter to skip, (q)uit? ")) ?? "").trim().toLowerCase();
  } catch {
    return "q";
  }
};

try {
  const all = values.section
    ? await store.decisionsOn(tenant.id, values.section, 1000)
    : await store.listDecisions(tenant.id);
  if (all.length === 0)
    console.log(`${tenant.id}: no decisions${values.section ? " on that section" : ""}`);
  for (const d of all) {
    const [question, section] = (d.key ?? "").split("@");
    console.log(`\n${question}  on ${section}`);
    console.log(`  ${d.content}`);
    console.log(
      `  answer: ${answerText(d.value)}   (${d.strength} time${d.strength === 1 ? "" : "s"}, last ${d.lastSeenAt.slice(0, 10)})`,
    );
    if (!rl) continue;
    const reply = await ask();
    if (reply === "q") break;
    if (reply === "f") await store.forgetEpisode(tenant.id, d.id);
  }
} finally {
  rl?.close();
  await pool.end();
}
