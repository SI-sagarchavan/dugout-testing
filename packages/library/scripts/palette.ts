// pnpm agent library palette --tenant sb [--propose] [--handoffs 10]
// The colours the tenant's own designs are painted in, as another club's skeletons are drawn for
// it: page, cards, accent, text and text on accent, counted by area over the sections of its
// latest previewed Handoffs, each read through the theme its preview used. --propose proposes it
// as the tenant's `library.palette` fact; a person approves it with `pnpm agent memory review`.
// The worker proposes one on its own after a tenant's first shared preview.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import {
  approvedPalette,
  learnPalette,
  loadFanosTools,
  paletteFact,
  previewReaders,
  proposePalette,
  skeletonSvg,
  surfaceConfig,
} from "../src/index.ts";
import { openLibrary } from "./common.ts";

loadEnv();
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    propose: { type: "boolean" },
    handoffs: { type: "string", default: "10" },
  },
});
if (!values.tenant) {
  console.error("usage: pnpm agent library palette --tenant <id> [--propose] [--handoffs 10]");
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const { pool, library, cropDir } = openLibrary();
const memory = createMemoryStore({ pool, embeddings: loadEmbeddings() });
const read = previewReaders({
  tenantId: tenant.id,
  surface: surfaceConfig(),
  tools: loadFanosTools,
});

const learned = await learnPalette({
  pool,
  tenantId: tenant.id,
  library,
  shapes: read.shapes,
  handoffs: Number(values.handoffs),
});
const approved = await approvedPalette(memory, tenant.id);
console.log(`approved: ${approved ? paletteFact(approved) : "none"}`);
if (!learned.palette) {
  console.log(
    `${tenant.id}: no palette: none of its ${learned.handoffs} previewed Handoffs with a theme painted anything readable`,
  );
} else {
  console.log(
    `from ${learned.sections} sections of ${learned.handoffs} Handoffs: ${paletteFact(learned.palette)}`,
  );
  // a swatch: every role in the palette, as a skeleton would draw them
  const dir = join(cropDir, "palettes");
  await mkdir(dir, { recursive: true });
  const swatch = join(dir, `${tenant.id}.svg`);
  await writeFile(
    swatch,
    skeletonSvg(
      {
        w: 480,
        h: 200,
        shapes: [
          { kind: "fill", x: 16, y: 16, w: 200, h: 168, r: 12, role: "surface" },
          { kind: "image", x: 28, y: 28, w: 176, h: 96, r: 8 },
          { kind: "text", x: 28, y: 136, w: 160, h: 36, lines: 2, onAccent: false },
          { kind: "fill", x: 232, y: 16, w: 232, h: 168, r: 12, role: "accent" },
          { kind: "text", x: 248, y: 40, w: 180, h: 40, lines: 2, onAccent: true },
          { kind: "outline", x: 248, y: 120, w: 120, h: 40, r: 20 },
        ],
      },
      learned.palette,
    ),
  );
  console.log(`swatch: ${swatch}`);
  if (values.propose) {
    const proposed = await proposePalette({
      memory,
      tenantId: tenant.id,
      palette: learned.palette,
    });
    console.log(
      proposed
        ? `proposed; approve it with pnpm agent memory review --tenant ${tenant.id}`
        : "the approved or a pending palette says the same: nothing proposed",
    );
  }
}
await pool.end();
