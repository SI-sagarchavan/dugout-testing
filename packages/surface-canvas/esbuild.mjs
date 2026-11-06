/**
 * Two bundles:
 *   src/main.ts    -> dist/code.js   (Figma sandbox, plain script)
 *   src/ui/main.tsx -> dist/ui.html  (React, inlined into the HTML shell;
 *                                    Figma only accepts a single
 *                                    self-contained UI file)
 *
 * The sandbox bundle carries the tenant theme JSON with it. Network access is
 * for Surface Studio events only — themes stay compiled in. Adding a tenant is
 * a new import in src/themes.ts and a rebuild.
 */
import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

const UI_PLACEHOLDER = "/* __UI_BUNDLE__ */";
const FONTS_PLACEHOLDER = "/* __FONTS__ */";

/**
 * The panel's mono face, inlined as base64 woff2: Figma accepts one self-contained
 * UI file and the plugin's network access is limited to the backend, so a font
 * cannot be fetched. Variable font, latin subset, SIL OFL (licence beside it). The
 * sans face is Inter, which Figma ships.
 */
async function fontFaces() {
  const face = async (family, file) => {
    const bytes = await readFile(resolve(root, "src/ui/fonts", file));
    return (
      `@font-face { font-family: "${family}"; font-style: normal; font-weight: 200 800; font-display: block; ` +
      `src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); }`
    );
  };
  return [
    await face("JetBrains Mono", "jetbrains-mono-latin-wght-normal.woff2"),
  ].join("\n");
}

/**
 * `@fanos/tokens` ships as a single bundled ESM file, and one module in it
 * (`load.ts`) imports `node:fs` for `loadTheme()`. The plugin never calls it —
 * themes are compiled in via src/themes.ts, which uses the pure
 * `normalizeTheme` + `rawThemeFileSchema` path — but esbuild resolves imports
 * while parsing, so the reference has to go somewhere.
 *
 * It goes to a stub that throws. Not an empty object: if anything in the sandbox
 * ever does reach for the filesystem, that should be a loud error at the call
 * site rather than `undefined is not a function` three frames away.
 */
const nodeBuiltinStubPlugin = {
  name: "node-builtin-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(node:)?(fs|path|url|os|crypto)$/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
      contents: `
        const unavailable = (name) => () => {
          throw new Error(
            "FanOS Studio: ${args.path}." + name + " is not available in the Figma sandbox. " +
            "Themes are compiled in at build time — see src/themes.ts."
          );
        };
        export const readFileSync = unavailable("readFileSync");
        export const writeFileSync = unavailable("writeFileSync");
        export const existsSync = unavailable("existsSync");
        export default new Proxy({}, { get: (_t, key) => unavailable(String(key)) });
      `,
      loader: "js",
    }));
  },
};

const shared = {
  bundle: true,
  target: "es2017",
  logLevel: "info",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  loader: { ".json": "json" },
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
};

/** Bundles ui/main.tsx and splices it into the <script> tag in ui/ui.html. */
const inlineUiPlugin = {
  name: "inline-ui",
  setup(pluginBuild) {
    pluginBuild.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const js = result.outputFiles?.[0]?.text ?? "";
      const shell = await readFile(resolve(root, "src/ui/ui.html"), "utf8");
      if (!shell.includes(UI_PLACEHOLDER)) {
        throw new Error(`src/ui/ui.html is missing the ${UI_PLACEHOLDER} marker`);
      }
      if (!shell.includes(FONTS_PLACEHOLDER)) {
        throw new Error(`src/ui/ui.html is missing the ${FONTS_PLACEHOLDER} marker`);
      }
      const fonts = await fontFaces();
      await mkdir(dist, { recursive: true });
      // Function replacer: a string replacer treats `$&` / `$`` / `$'` in the
      // bundle as replacement patterns. Minified React contains `$&` (regex
      // "whole match"), which became `/* __UI_BUNDLE__ */` and produced a
      // syntax-error script — blank plugin iframe.
      await writeFile(
        resolve(dist, "ui.html"),
        shell.replace(FONTS_PLACEHOLDER, () => fonts).replace(UI_PLACEHOLDER, () => js),
      );
      console.log("  dist/ui.html");
    });
  },
};

const codeConfig = {
  ...shared,
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(dist, "code.js"),
  format: "iife",
  plugins: [nodeBuiltinStubPlugin],
};

const uiConfig = {
  ...shared,
  entryPoints: [resolve(root, "src/ui/main.tsx")],
  format: "iife",
  jsx: "automatic",
  write: false,
  outfile: resolve(dist, "ui.js"),
  plugins: [nodeBuiltinStubPlugin, inlineUiPlugin],
};

if (watch) {
  const contexts = await Promise.all([context(codeConfig), context(uiConfig)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("watching…");
} else {
  await Promise.all([build(codeConfig), build(uiConfig)]);
}
