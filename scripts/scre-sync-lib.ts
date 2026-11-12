// What `pnpm scre:sync` copies into SCRE (fanxp-web-renderer-sdui `packages/scre`, the renderer
// Surface Studio draws sections with) and how: dugout's `packages/dsl/src` into `scre/src/dsl/`,
// `packages/renderer/src` into `scre/src/`, exact copies but for their `@fanos/*` imports, which
// become relative paths to SCRE's own `dsl/index.ts`, `tokens.ts` and `client.tsx`, and the few
// lines in `PATCHES` where SCRE reads the tenant's theme.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

/** SCRE's own files, under `scre/src`: never written. */
export const SCRE_ONLY = new Set([
  "index.ts",
  "tokens.ts",
  "section.ts",
  "section-css.ts",
  "components/SurfaceSection.tsx",
  "dsl/index.ts",
]);

/** Where each `@fanos/*` module a copy imports lives in SCRE, relative to `scre/src`. */
const TARGETS: Record<string, string> = {
  "@fanos/dsl": "dsl/index.js",
  "@fanos/dsl/runtime": "dsl/index.js",
  "@fanos/tokens": "tokens.js",
  "@fanos/renderer/client": "client.js",
};

/**
 * Where SCRE's copy differs from dugout beyond its imports: SCRE draws with the tenant's own theme
 * (`--spacing_1`, `--x-hex`, `hsl(var(--x) / a)`; see SCRE's `tokens.ts`), not dugout's `--fos-*`
 * one, and its `tokens.ts` has no `cssRgbVarName`. Each `find` must occur once in the rewritten
 * file; when dugout changes that line the sync stops, to be decided again here. Fix the cause in
 * dugout (read token refs through `cssVar`) and the patch can go.
 */
export const PATCHES: Record<string, Array<{ find: string; replace: string }>> = {
  "components/Divider.tsx": [
    {
      find: 'import { cssRgbVarName, cssVar, cssVarName } from "../tokens.js";',
      replace: 'import { colorWithAlpha, cssVar } from "../tokens.js";',
    },
    {
      find: " * tone + opacity compose to `background: rgb(var(--x-rgb) / var(--opacity))`.\n * Opacity tokens are emitted as 0–1 unit values.",
      replace:
        " * tone + opacity compose to `background: hsl(var(--x) / var(--opacity_y))`: the tenant declares\n * each colour as an HSL triple beside its hex, and each opacity as a 0–1 value.",
    },
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template literal in dugout's file
      find: "style.background = `rgb(var(${cssRgbVarName(tone)}) / var(${cssVarName(opacity)}))`;",
      replace: "style.background = colorWithAlpha(tone, cssVar(opacity));",
    },
  ],
  "resolve/value.ts": [
    {
      find: " * Token refs become `var(--fos-…)` references (never inlined).\n * Negative token refs become `calc(-1 * var(--fos-…))`.",
      replace:
        " * Token refs become the tenant's `var(--…)` references (never inlined; see tokens.ts).\n * Negative token refs become `calc(-1 * var(--…))`.",
    },
    {
      find: 'import { cssVar, cssVarName } from "../tokens.js";',
      replace: 'import { cssVar } from "../tokens.js";',
    },
    // SCRE's cssVarName is undefined for a ref the tenant declares no variable for (motion)
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template literal in dugout's file
      find: "return { css: `var(${cssVarName(value)})`, raw: false, relative: false };",
      replace: "return { css: cssVar(value), raw: false, relative: false };",
    },
  ],
  "styles.css": [
    { find: "gap: var(--fos-space-1, 0.25rem);", replace: "gap: var(--spacing_1, 0.25rem);" },
    {
      find: "border-radius: var(--fos-radius-md, 0);",
      replace: "border-radius: var(--radius_md, 0);",
    },
  ],
};

/** Applies a file's patches; throws when one no longer matches exactly once. */
export function applyPatches(text: string, screPath: string): string {
  let out = text;
  for (const { find, replace } of PATCHES[screPath] ?? []) {
    const at = out.indexOf(find);
    if (at < 0 || out.indexOf(find, at + 1) >= 0) {
      const how = at < 0 ? "no longer in" : "more than once in";
      throw new Error(
        `${screPath}: patch text is ${how} dugout's file; update PATCHES in scripts/scre-sync-lib.ts:\n  ${find}`,
      );
    }
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return out;
}

/** A module specifier from one file under `scre/src` to another, as an import writes it. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * The SCRE copy of a dugout file that lands at `screPath` (relative to `scre/src`): the same
 * text with each `@fanos/*` import pointed at SCRE's file. Throws on a `@fanos/*` import SCRE has
 * no file for.
 */
export function rewriteImports(source: string, screPath: string): string {
  const unknown: string[] = [];
  const out = source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(@fanos\/[^"']+)\2/g,
    (match, lead: string, quote: string, spec: string) => {
      const target = TARGETS[spec];
      if (!target) {
        unknown.push(spec);
        return match;
      }
      return `${lead}${quote}${relativeSpecifier(screPath, target)}${quote}`;
    },
  );
  if (unknown.length > 0) {
    throw new Error(
      `${screPath}: imports ${[...new Set(unknown)].join(", ")}, which SCRE has no file for`,
    );
  }
  return out;
}

/** Every file under `dir`, as paths relative to it with `/` separators. */
function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, base);
    return [relative(base, path).split("\\").join("/")];
  });
}

/** The relative imports of a TS source, resolved to the source files they name (`./x.js` → `x.ts`). */
function relativeImports(source: string, fromFile: string, srcDir: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const spec = posix.join(posix.dirname(fromFile), m[1] as string);
    const stem = spec.replace(/\.(js|jsx|ts|tsx)$/, "");
    const hit = [`${stem}.ts`, `${stem}.tsx`, spec].find((p) => existsSync(join(srcDir, p)));
    if (hit) found.push(hit);
  }
  return found;
}

export interface CopyFile {
  /** Path under `scre/src`. */
  scre: string;
  /** Absolute path of the dugout source. */
  from: string;
}

export interface Plan {
  files: CopyFile[];
  /** Files in SCRE's `dsl/` that dugout no longer has (left alone; delete them by hand). */
  stale: string[];
}

/**
 * What to copy: each file SCRE has (outside its own) with a counterpart in dugout, plus the
 * dugout files those import that SCRE does not have yet.
 */
export function planSync(dugoutRoot: string, screDir: string): Plan {
  const dslSrc = join(dugoutRoot, "packages/dsl/src");
  const rendererSrc = join(dugoutRoot, "packages/renderer/src");
  const screSrc = join(screDir, "src");
  const files = new Map<string, CopyFile>();
  const stale: string[] = [];

  const add = (scre: string, from: string, srcDir: string, prefix: string) => {
    if (SCRE_ONLY.has(scre) || files.has(scre)) return;
    files.set(scre, { scre, from });
    if (!/\.tsx?$/.test(from)) return;
    const own = from
      .slice(srcDir.length + 1)
      .split("\\")
      .join("/");
    for (const dep of relativeImports(readFileSync(from, "utf8"), own, srcDir)) {
      add(`${prefix}${dep}`, join(srcDir, dep), srcDir, prefix);
    }
  };

  for (const file of filesUnder(join(screSrc, "dsl"))) {
    const scre = `dsl/${file}`;
    if (SCRE_ONLY.has(scre)) continue;
    const from = join(dslSrc, file);
    if (existsSync(from)) add(scre, from, dslSrc, "dsl/");
    else stale.push(scre);
  }
  for (const file of filesUnder(screSrc)) {
    if (file.startsWith("dsl/") || SCRE_ONLY.has(file)) continue;
    const from = join(rendererSrc, file);
    if (existsSync(from)) add(file, from, rendererSrc, "");
  }
  return { files: [...files.values()].sort((a, b) => a.scre.localeCompare(b.scre)), stale };
}

/** The text SCRE's copy should hold. */
export function expectedCopy(file: CopyFile): string {
  const source = readFileSync(file.from, "utf8");
  const rewritten = /\.tsx?$/.test(file.scre) ? rewriteImports(source, file.scre) : source;
  return applyPatches(rewritten, file.scre);
}
