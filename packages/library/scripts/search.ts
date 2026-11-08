// pnpm agent library search --tenant demo-cricket "fixtures carousel with crests" [--shared]
//   [--image <png>] [--kind fixtures] [--layout carousel] [--limit 10]
//   [--accent '#hex'] [--surface '#hex'] [--page '#hex'] [--ink '#hex'] [--on-accent '#hex']
// The tenant's section library, by words, a picture, or both; with --shared, other tenants'
// shared sections too. The tenant's own come with their picture; another tenant's with its
// skeleton, written as an SVG in the tenant's approved palette (`library.palette`, proposed from
// its own designs; `pnpm agent library palette`), any colour given as a flag over it, neutral
// greys until one is approved.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createMemoryStore, loadEmbeddings } from "@dugout/memory";
import { approvedPalette, NEUTRAL_PALETTE, shapeWords, skeletonSvg } from "../src/index.ts";
import { openLibrary, paletteFrom } from "./common.ts";

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: "string" },
    shared: { type: "boolean" },
    image: { type: "string" },
    kind: { type: "string" },
    layout: { type: "string" },
    limit: { type: "string", default: "10" },
    accent: { type: "string" },
    surface: { type: "string" },
    page: { type: "string" },
    ink: { type: "string" },
    "on-accent": { type: "string" },
  },
});
const text = positionals.join(" ").trim();
if (!values.tenant || (!text && !values.image)) {
  console.error(
    'usage: pnpm agent library search --tenant <id> "<words>" [--shared] [--image <png>] [--kind <k>] [--layout <l>] [--limit 10] [--accent <hex>] [--surface <hex>] [--page <hex>] [--ink <hex>] [--on-accent <hex>]',
  );
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const { pool, library, cropDir } = openLibrary();
const approved = await approvedPalette(
  createMemoryStore({ pool, embeddings: loadEmbeddings() }),
  tenant.id,
);
const palette = paletteFrom(
  { ...values, onAccent: values["on-accent"] },
  approved ?? NEUTRAL_PALETTE,
);
const skeletonDir = join(cropDir, "skeletons", tenant.id);

const results = await library.search(tenant.id, {
  ...(text ? { text } : {}),
  ...(values.image ? { image: await readFile(values.image) } : {}),
  ...(values.kind ? { kind: values.kind } : {}),
  ...(values.layout ? { layout: values.layout } : {}),
  limit: Number(values.limit),
  scope: values.shared ? "shared" : "own",
});
if (results.length === 0) console.log(`${tenant.id}: nothing found`);
for (const [i, s] of results.entries()) {
  const what = `[${s.kind}${s.layout !== "none" ? `, ${s.layout}` : ""}] score ${s.score.toFixed(4)}`;
  console.log(
    s.own
      ? `\n${i + 1}. ${s.name} ${what}, seen in ${s.sources.length} Handoff${s.sources.length === 1 ? "" : "s"}${s.previewedAt ? ", previewed" : ""}`
      : `\n${i + 1}. another club's ${what}`,
  );
  if (s.caption) console.log(`   ${s.caption}`);
  if (s.tags.length) console.log(`   tags: ${s.tags.join(", ")}`);
  if (s.dataShape) console.log(`   ${shapeWords(s.dataShape)}`);
  console.log(`   structure: ${s.summary}`);
  if (s.own && s.cropKey) {
    console.log(`   picture: ${join(cropDir, s.cropKey)} (${s.cropWidth}×${s.cropHeight})`);
  } else if (s.skeleton) {
    await mkdir(skeletonDir, { recursive: true });
    const path = join(skeletonDir, `${s.id}.svg`);
    await writeFile(path, skeletonSvg(s.skeleton, palette));
    console.log(`   skeleton: ${path}${approved ? "" : " (neutral colours: no approved palette)"}`);
  }
}
await pool.end();
