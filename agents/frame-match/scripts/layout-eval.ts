// pnpm eval layout — layout detection on every eval frame and held-out design, against
// evals/layouts.ts. No model and no render: the IR alone. Exits non-zero on any miss, because a
// static row shipped as a carousel, or a carousel shipped as a row, is a wrong page.
import { FRAMES, HOLDOUT } from "../evals/frames.ts";
import { LAYOUT_LABELS } from "../evals/layouts.ts";
import { createControlPlane } from "../src/control-plane.ts";
import { loadBundle } from "../src/frame.ts";
import { loadToolchain } from "../src/toolchain.ts";

const tools = await loadToolchain();
const plane = createControlPlane("default");
let checks = 0;
const misses: string[] = [];

for (const frame of [...FRAMES, ...HOLDOUT]) {
  const labels = LAYOUT_LABELS[frame.id];
  if (!labels) {
    misses.push(`${frame.id}: no labels in evals/layouts.ts`);
    continue;
  }
  const bundle = await loadBundle(tools, plane, frame.exportId);
  const intents = tools.detectLayout(bundle.doc);
  const bySrc = new Map(intents.map((i) => [i.src, i]));
  const lines: string[] = [];
  for (const label of labels) {
    checks++;
    const got = bySrc.get(label.src);
    const wrong: string[] = [];
    if (!got) wrong.push("not detected");
    else {
      if (got.kind !== label.kind) wrong.push(`kind ${got.kind}`);
      if (label.confidence && got.confidence !== label.confidence)
        wrong.push(`confidence ${got.confidence}`);
      for (const part of label.chrome ?? [])
        if (!got.chrome[part]) wrong.push(`no ${part} control`);
      const centered = got.choice.kind === "carousel" && got.choice.config.centered;
      if (label.centered !== undefined && centered !== label.centered)
        wrong.push(`centered ${centered}`);
    }
    lines.push(
      `  ${wrong.length === 0 ? "ok  " : "MISS"} ${label.kind.padEnd(8)} ${label.src.padEnd(12)} ${label.what}${wrong.length ? ` — ${wrong.join(", ")}` : ""}`,
    );
    if (wrong.length) misses.push(`${frame.id} ${label.src} (${label.what}): ${wrong.join(", ")}`);
  }
  // A carousel nobody labelled is a row that will scroll on someone's page.
  for (const intent of intents) {
    if (intent.kind !== "carousel" || labels.some((l) => l.src === intent.src)) continue;
    checks++;
    lines.push(
      `  MISS carousel ${intent.src.padEnd(12)} "${intent.name}" is not a carousel — ${intent.evidence.join("; ")}`,
    );
    misses.push(`${frame.id} ${intent.src}: an unlabelled carousel ("${intent.name}")`);
  }
  console.log(`\n${frame.id}${lines.length === 0 ? "  (nothing to score)" : ""}`);
  for (const line of lines) console.log(line);
}
await tools.closeBrowser();

console.log(`\n${checks - misses.length} of ${checks} right`);
if (misses.length > 0) {
  console.log("\nMisses:");
  for (const miss of misses) console.log(`  ${miss}`);
  process.exit(1);
}
process.exit(0);
