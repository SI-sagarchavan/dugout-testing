// pnpm eval sections — the section finder on each case in evals/sections.ts, against what a
// person reads in the design: background, bands, slots. No model, no control plane: the IR is
// in evals/sections/. Exits non-zero on any miss.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSlots, type IrDoc } from "@dugout/library";
import { SECTION_CASES } from "../evals/sections.ts";
import { loadToolchain } from "../src/toolchain.ts";

const here = join(dirname(fileURLToPath(import.meta.url)), "../evals/sections");
const read = <T>(file: string) => JSON.parse(readFileSync(join(here, file), "utf8")) as T;

const tools = await loadToolchain();
let misses = 0;
const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
const show = (slots: string[][]) =>
  slots
    .map((n) => `[${[...n].sort().join(" ")}]`)
    .sort()
    .join(" ");

for (const c of SECTION_CASES) {
  const raw = read<Record<string, unknown>>(`${c.ir ?? c.id}.ir.json`);
  const doc = tools.parseIr(c.annotations ? { ...raw, annotations: c.annotations } : raw);
  const layouts = tools.detectLayout(doc);
  const found = findSlots(doc as unknown as IrDoc, { layouts });
  for (const slot of found.bands.flatMap((b) => b.slots))
    if (slot.confidence === "unsure") console.log(`       (unsure ${slot.id}: ${slot.why})`);

  const wantSlots = c.bands.flatMap((b) => b.slots.map((s) => s.nodes));
  const gotSlots = found.bands.flatMap((b) => b.slots.map((s) => s.nodes));
  const wrong: string[] = [];
  if (!same(found.background, c.background))
    wrong.push(`background: want [${c.background}], got [${found.background}]`);
  if (found.bands.length !== c.bands.length)
    wrong.push(`bands: want ${c.bands.length}, got ${found.bands.length}`);
  if (show(wantSlots) !== show(gotSlots))
    wrong.push(`slots: want ${show(wantSlots)}, got ${show(gotSlots)}`);
  console.log(`${wrong.length === 0 ? "ok  " : "MISS"} ${c.id}  ${c.what}`);
  for (const w of wrong) console.log(`       ${w}`);
  if (wrong.length) misses++;
}
await tools.closeBrowser();
console.log(`\n${SECTION_CASES.length - misses} of ${SECTION_CASES.length} right`);
process.exit(misses ? 1 : 0);
