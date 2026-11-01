// pnpm eval measure [--write [--all]] — the code-only result for each eval frame, no model.
// Without --write it prints a table next to the recorded baseline (evals/baseline.json). With it,
// frames not recorded yet are added, so a later run shows what changed; --all re-records them all.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMES, HOLDOUT } from "../evals/frames.ts";
import { createControlPlane } from "../src/control-plane.ts";
import { buildFrame, firstPass, loadBundle, noOverrides } from "../src/frame.ts";
import { loadToolchain } from "../src/toolchain.ts";

const FILE = join(import.meta.dirname, "..", "evals", "baseline.json");
const write = process.argv.includes("--write");

interface Row {
  match: number;
  coverage: number;
  conformErrors: number;
  placeholderIcons: number;
  standIns: number;
  /** The same frame with every crop taken out: what the compiler and the real fixes reach alone. */
  withoutCrops?: number;
}

const tools = await loadToolchain();
const plane = createControlPlane("default");
const now: Record<string, { compiled: Row; firstPass: Row }> = {};
const GROUPS = [
  ...FRAMES.map((frame) => ({ ...frame, group: "tuned" })),
  ...HOLDOUT.map((frame) => ({ ...frame, group: "holdout" })),
];
for (const frame of GROUPS) {
  const bundle = await loadBundle(tools, plane, frame.exportId);
  const row = (
    built: ReturnType<typeof buildFrame>,
    m: Awaited<ReturnType<typeof firstPass>>["measurement"],
  ): Row => ({
    match: m.match,
    coverage: m.coverage,
    conformErrors: m.conformErrors,
    placeholderIcons: m.placeholderIcons,
    standIns: built.cropped.length,
  });
  const { measureFrame } = await import("../src/frame.ts");
  const plain = buildFrame(tools, bundle, noOverrides());
  const plainMeasured = await measureFrame(tools, bundle, plain);
  const first = await firstPass(tools, bundle, noOverrides(), plainMeasured);
  // what is left when the crops go: the part of the result that is the pipeline's, not a copy
  const bare = buildFrame(tools, bundle, { ...first.overrides, crops: [], drops: [] });
  const withoutCrops =
    bare.errors.length > 0 ? undefined : (await measureFrame(tools, bundle, bare)).match;
  now[frame.id] = {
    compiled: row(plain, plainMeasured),
    firstPass: {
      ...row(first.built, first.measurement),
      ...(withoutCrops ? { withoutCrops } : {}),
    },
  };
}
await tools.closeBrowser();

let recorded: { recordedAt?: string; note?: string; frames?: typeof now; [key: string]: unknown } =
  {};
try {
  recorded = JSON.parse(readFileSync(FILE, "utf8"));
} catch {
  // nothing recorded yet
}
const show = (r: Row | undefined) =>
  r
    ? `${r.withoutCrops === undefined ? "" : `no crops ${String(r.withoutCrops).padStart(6)}%  `}match ${String(r.match).padStart(6)}%  coverage ${String(r.coverage).padStart(6)}%  conform ${String(r.conformErrors).padStart(3)}  placeholders ${String(r.placeholderIcons).padStart(2)}  crops ${r.standIns}`
    : "(not recorded)";
for (const frame of GROUPS) {
  console.log(`\n${frame.group === "holdout" ? "[holdout] " : ""}${frame.id}  (${frame.exportId})`);
  console.log(`  baseline  ${show(recorded.frames?.[frame.id]?.firstPass)}`);
  console.log(`  now       ${show(now[frame.id]?.firstPass)}`);
}
if (write) {
  // A recorded frame stays as it was, so "before" keeps meaning before. --all records them afresh.
  const all = process.argv.includes("--all");
  const frames = { ...(all ? {} : recorded.frames), ...now, ...(all ? {} : recorded.frames) };
  // Re-recording keeps the old numbers, with the date they were taken.
  const earlier = (recorded.earlier ?? []) as unknown[];
  const next = all
    ? {
        ...recorded,
        recordedAt: new Date().toISOString(),
        note: "re-recorded before the next fixes",
        earlier: [
          ...earlier,
          { recordedAt: recorded.recordedAt, note: recorded.note, frames: recorded.frames },
        ],
        frames,
      }
    : { ...recorded, frames };
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nrecorded to ${FILE}`);
}
process.exit(0);
