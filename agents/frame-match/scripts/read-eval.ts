// pnpm eval read [--model <name>] [--only id,id] — the first look (`src/read.ts`) on every eval
// frame, held-out design and local frame, against evals/layouts.ts: what a person reads in each
// design. Live: one vision call per frame. Exits non-zero on any miss.
//
// A miss is: a labelled container read as another kind; a carousel the frame shows that is only
// asked about instead of applied; a designed control not wired; a layer of a carousel's one slide
// left out of it, or a pinned part put in it; and anything applied unasked that nobody labelled
// (a static row that would scroll on someone's page). A container labelled `unsure` may be asked
// about or read as its labelled kind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { describeImage, loadEnv } from "@dugout/core";
import { FRAMES, HOLDOUT } from "../evals/frames.ts";
import { LAYOUT_LABELS, type LayoutLabel, LOCAL_FRAMES, LOCAL_LABELS } from "../evals/layouts.ts";
import { createControlPlane } from "../src/control-plane.ts";
import { loadBundle } from "../src/frame.ts";
import { designPicture, type Ir, type Reading, readPicture } from "../src/read.ts";
import { type IrNode, loadToolchain } from "../src/toolchain.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: process.env.FRAME_MATCH_READ_MODEL ?? "sonnet" },
    only: { type: "string" },
    concurrency: { type: "string", default: "4" },
    repeat: { type: "string", default: "1" },
    dump: { type: "boolean", default: false },
  },
});
loadEnv();
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : undefined;
const model = values.model as string;

const tools = await loadToolchain();
const plane = createControlPlane("default");
const read = (png: Buffer, prompt: string, signal?: AbortSignal) =>
  describeImage({ png, prompt, model, ...(signal ? { signal } : {}) });

interface Case {
  id: string;
  labels: LayoutLabel[];
  load(): Promise<{
    png: Buffer;
    doc: { root: IrNode };
    ir: Ir;
    detected: ReturnType<typeof tools.detectLayout>;
  }>;
}

const indexed = (root: IrNode): Ir => {
  const byId = new Map<string, IrNode>();
  const parents = new Map<string, string | null>();
  const walk = (n: IrNode, parent: string | null) => {
    byId.set(n.id, n);
    parents.set(n.id, parent);
    for (const c of n.children ?? []) walk(c, n.id);
  };
  walk(root, null);
  return { byId, parents };
};

const cases: Case[] = [
  ...[...FRAMES, ...HOLDOUT].map(
    (frame): Case => ({
      id: frame.id,
      labels: LAYOUT_LABELS[frame.id] ?? [],
      load: async () => {
        const bundle = await loadBundle(tools, plane, frame.exportId);
        return {
          png: tools.png.write(designPicture(tools, bundle)),
          doc: bundle.doc,
          ir: { byId: bundle.byId, parents: bundle.parents },
          detected: tools.detectLayout(bundle.doc),
        };
      },
    }),
  ),
  ...LOCAL_FRAMES.map(
    (frame): Case => ({
      id: frame.id,
      labels: LOCAL_LABELS[frame.id] ?? [],
      load: async () => {
        const dir = join(import.meta.dirname, "../evals");
        const doc = tools.parseIr(JSON.parse(readFileSync(join(dir, frame.ir), "utf8")));
        return {
          png: readFileSync(join(dir, frame.design)),
          doc,
          ir: indexed(doc.root),
          detected: tools.detectLayout(doc),
        };
      },
    }),
  ),
].filter((c) => !only || only.has(c.id));

/** What is wrong with one label's reading; [] when it is right. */
export function grade(label: LayoutLabel, reading: Reading): string[] {
  const got = reading.layouts.find((l) => l.src === label.src);
  if (!got) return ["not read"];
  const wrong: string[] = [];
  const kind = got.choice.kind;
  if (label.confidence === "unsure") {
    if (kind !== label.kind && got.confidence !== "unsure") wrong.push(`read as ${kind}, sure`);
  } else {
    if (kind !== label.kind) wrong.push(`read as ${kind}`);
    // applied as frame.load applies: a carousel when certain, tabs unless unsure
    const applied =
      got.confidence === "certain" || (kind === "tabs" && got.confidence === "likely");
    const mustApply = label.confidence === "certain" || label.kind === "tabs";
    if (mustApply && !applied) wrong.push(`asked (${got.confidence}, ${got.score}), not applied`);
  }
  for (const part of label.chrome ?? []) if (!got.chrome[part]) wrong.push(`no ${part} control`);
  const slide = new Set(got.slide ?? []);
  for (const id of label.slide ?? []) if (!slide.has(id)) wrong.push(`${id} not in the slide`);
  for (const id of label.notSlide ?? []) if (slide.has(id)) wrong.push(`${id} put in the slide`);
  return wrong;
}

interface Result {
  id: string;
  lines: string[];
  misses: string[];
  checks: number;
  asks: number;
}

async function run(c: Case): Promise<Result> {
  const lines: string[] = [];
  const misses: string[] = [];
  let checks = 0;
  let reading: Reading;
  try {
    const loaded = await c.load();
    reading = await readPicture({ ...loaded, read });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      id: c.id,
      lines: [`  FAIL could not read: ${why}`],
      misses: [`${c.id}: ${why}`],
      checks: 1,
      asks: 0,
    };
  }
  for (const label of c.labels) {
    checks++;
    const wrong = grade(label, reading);
    lines.push(
      `  ${wrong.length === 0 ? "ok  " : "MISS"} ${label.kind.padEnd(8)} ${label.src.padEnd(14)} ${label.what}${wrong.length ? ` — ${wrong.join(", ")}` : ""}`,
    );
    if (wrong.length) misses.push(`${c.id} ${label.src} (${label.what}): ${wrong.join(", ")}`);
    if (wrong.includes("not read")) {
      const seen = reading.layouts.map(
        (l) => `${l.choice.kind} ${l.src} "${l.name}" (${l.confidence})`,
      );
      lines.push(`       read instead: ${seen.join("; ") || "no containers"}`);
    }
  }
  // applied unasked, and nobody labelled it: it would move on someone's page
  for (const l of reading.layouts) {
    if (c.labels.some((label) => label.src === l.src)) continue;
    // a carousel nobody labelled scrolls a static row; tabs nobody labelled are reported, not
    // failed, as `pnpm eval layout` does
    if (l.confidence !== "certain") continue;
    if (l.choice.kind === "tabs") {
      lines.push(
        `  ·    tabs ${l.src} "${l.name}" applied, unlabelled: ${l.evidence.slice(0, 2).join("; ")}`,
      );
      continue;
    }
    if (l.choice.kind !== "carousel") continue;
    checks++;
    lines.push(
      `  MISS ${l.choice.kind.padEnd(8)} ${l.src.padEnd(14)} "${l.name}" applied, and nobody labelled it — ${l.evidence.slice(0, 2).join("; ")}`,
    );
    misses.push(`${c.id} ${l.src}: an unlabelled ${l.choice.kind} applied ("${l.name}")`);
  }
  const asks = reading.layouts.filter(
    (l) => l.confidence === "unsure" && !c.labels.some((label) => label.src === l.src),
  ).length;
  if (asks > 0) lines.push(`  ·    ${asks} other container(s) put to the agent as a question`);
  if (reading.dropped.length > 0)
    lines.push(`  ·    not borne out: ${reading.dropped.slice(0, 3).join("; ")}`);
  if (values.dump) {
    for (const l of reading.layouts)
      lines.push(
        `  ~    ${l.choice.kind} ${l.src} "${l.name}" ${l.confidence} ${l.score} | ${l.evidence.join(" | ").slice(0, 300)}`,
      );
    for (const d of reading.dropped) lines.push(`  ~    dropped: ${d}`);
  }
  if (reading.experience) lines.push(`  ·    ${reading.experience.slice(0, 160)}`);
  return { id: c.id, lines, misses, checks, asks };
}

/** Each case read `repeat` times: right only when right every time, and flaky lines say so. */
const repeat = Math.max(1, Number(values.repeat));
async function runRepeated(c: Case): Promise<Result> {
  const runs: Result[] = [];
  for (let i = 0; i < repeat; i++) runs.push(await run(c));
  if (repeat === 1) return runs[0] as Result;
  const counts = new Map<string, number>();
  for (const r of runs) for (const m of new Set(r.misses)) counts.set(m, (counts.get(m) ?? 0) + 1);
  const misses = [...counts].map(([m, n]) =>
    n === repeat ? m : `${m} (in ${n} of ${repeat} reads)`,
  );
  const first = runs[0] as Result;
  return {
    id: c.id,
    lines: [
      ...first.lines,
      ...(counts.size > 0 ? [`  ·    over ${repeat} reads: ${misses.length} miss(es)`] : []),
    ],
    misses,
    checks: Math.max(...runs.map((r) => r.checks)),
    asks: first.asks,
  };
}

const results: Result[] = [];
const queue = [...cases];
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) results.push(await runRepeated(c));
  }),
);
await tools.closeBrowser();

results.sort(
  (a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id),
);
for (const r of results) {
  console.log(`\n${r.id}${r.lines.length === 0 ? "  (nothing to score)" : ""}`);
  for (const line of r.lines) console.log(line);
}
const checks = results.reduce((n, r) => n + r.checks, 0);
const misses = results.flatMap((r) => r.misses);
console.log(
  `\n${checks - misses.length} of ${checks} right (${model}); ${results.reduce((n, r) => n + r.asks, 0)} other questions`,
);
if (misses.length > 0) {
  console.log("\nMisses:");
  for (const miss of misses) console.log(`  ${miss}`);
  process.exit(1);
}
process.exit(0);
