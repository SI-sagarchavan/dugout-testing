// pnpm scre:sync [--check] [--to <dir>] — copies dugout's DSL (`packages/dsl/src`) and renderer
// (`packages/renderer/src`) into SCRE, the renderer Surface Studio draws sections with
// (fanxp-web-renderer-sdui `packages/scre`; `SCRE_DIR` or `--to` names another), as exact copies
// but for their `@fanos/*` imports and the lines in `PATCHES` (scre-sync-lib.ts). It copies the files SCRE has, and what those import; SCRE's
// own files (`index.ts`, `tokens.ts`, `section*.ts`, `SurfaceSection.tsx`, `dsl/index.ts`) are
// never written. `--check` writes nothing and exits 1 when a copy differs or is missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedCopy, planSync } from "./scre-sync-lib.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const toAt = args.indexOf("--to");
const to = toAt >= 0 ? args[toAt + 1] : process.env.SCRE_DIR;
const screDir = to ? resolve(to) : resolve(root, "../fanxp-web-renderer-sdui/packages/scre");
const near = relative(process.cwd(), screDir) || ".";
const shown = near.startsWith("../../") ? screDir : near;

if (!existsSync(join(screDir, "src"))) {
  console.log(`scre:sync: no SCRE at ${shown} (set SCRE_DIR or --to); nothing to do`);
  process.exit(0);
}

const { files, stale } = planSync(root, screDir);
const changed: string[] = [];
for (const file of files) {
  const target = join(screDir, "src", file.scre);
  const want = expectedCopy(file);
  const have = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (have === want) continue;
  changed.push(`${have === undefined ? "missing" : "differs"}  src/${file.scre}`);
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, want);
  }
}

for (const file of stale)
  console.log(`stale    src/${file} (dugout has no such file; not removed)`);
if (check) {
  if (changed.length > 0) {
    for (const line of changed) console.log(line);
    console.log(
      `scre:sync --check: ${changed.length} of ${files.length} copies in ${shown} are out of date; run pnpm scre:sync`,
    );
    process.exit(1);
  }
  console.log(`scre:sync --check: ${files.length} copies in ${shown} match dugout`);
} else {
  for (const line of changed)
    console.log(
      line.replace(/^(missing|differs)/, (w) => (w === "missing" ? "added  " : "updated")),
    );
  console.log(`scre:sync: ${changed.length} of ${files.length} copies written to ${shown}`);
}
