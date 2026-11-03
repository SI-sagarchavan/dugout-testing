/**
 * Server-side SDUI preview: a run's compiled tree, as a page.
 *
 * Rendered here rather than in the board's bundle for three reasons:
 *
 *   1. `@fanos/tokens` reaches for `node:fs` on the theme-loading path. In Node
 *      that is simply correct; in a browser bundle it needs the same stubbing
 *      dance the Figma plugin has to do, for no gain.
 *   2. The renderer's stylesheet is global — `[data-fos-root]`, font faces, a
 *      `:root` block full of theme variables. Dropped into the board's own
 *      document it would style the board. An iframe is a real style boundary.
 *   3. It is what the Playwright harness already does. Preview and screenshot
 *      diverging would make the fidelity numbers describe a page nobody sees.
 *
 * The HTML mirrors `renderToPng`'s `buildPage`: same font CSS, same emitted
 * theme CSS, same base stylesheet, same order. That is deliberate — this is a
 * second consumer of one recipe, not a second recipe.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { BindingPlan } from "@fanos/dsl";
import { FONT_FACE_CSS, preparePage, Render } from "@fanos/renderer";

export interface PreviewSource {
  tree: unknown;
  theme: unknown;
  /**
   * The surface set the tree's `surface.*` refs resolve against.
   *
   * Not optional in practice: the compiler folds plate fills into surface refs,
   * so without this every background, button and overlay resolves to nothing
   * and the page renders as text floating on white.
   */
  surfaces?: unknown;
  /** Painted behind the tree; a compiled frame is often transparent. */
  background?: string;
  width?: number;
  /**
   * The bag the tree's `{path}` bindings resolve against.
   *
   * A compiled tree has none — the compiler keeps Figma's literal characters —
   * so this does nothing until a tree has been bound. Passing it anyway is what
   * makes the preview show a bound surface as content rather than as a page of
   * `{section.title}` placeholders.
   */
  data?: Record<string, unknown>;
  /**
   * Applied before rendering, when the tree has no bindings of its own.
   *
   * A compiled tree keeps Figma's literal characters, so handing it `data`
   * changes nothing — which is why `?data=` on a fresh run looks broken. A plan
   * is what turns one into the other, and it is keyed by `src`, so applying one
   * that belongs to a different frame is a no-op rather than damage: every
   * entry drifts and the tree comes back untouched.
   *
   * Skipped entirely when the tree is ALREADY bound. A tree that has been
   * through the authoring step must not be re-bound on the way to a screen.
   */
  plan?: BindingPlan;
  /**
   * The tenant site the data's root-relative URLs belong to. A CAST payload's
   * images are `/static-assets/…` and its links `/news/…`; rendered on :3000
   * without this, every one of them is requested from Studio and 404s.
   */
  origin?: string;
  /** IANA zone for the `date` pipe; UTC when unset. */
  timeZone?: string;
}

export interface RenderedPreview {
  /** What a binding plan did, when one was applied. Absent when none was. */
  binding?: { bound: number; collapsed: number; drift: string[] };
  html: string;
  width: number;
}

/**
 * Build the standalone preview document.
 *
 * Synchronous React only — `Render` is a Server Component in the RSC sense but
 * takes no async path, which is exactly why `renderToStaticMarkup` can drive it
 * outside Next.
 */
export async function renderPreview(source: PreviewSource): Promise<RenderedPreview> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");

  // The same recipe apps/web follows, so a Send looks the same in both.
  const page = preparePage({
    tree: source.tree,
    theme: source.theme,
    ...(source.surfaces !== undefined ? { surfaces: source.surfaces } : {}),
    ...(source.width ? { width: source.width } : {}),
    ...(source.plan ? { plan: source.plan } : {}),
  });
  // Named, never silent: what a plan could not land is the review queue.
  for (const d of page.binding?.drift ?? []) console.warn(`[preview] plan drift ${d}`);
  const { tree, css, assets, width, fluid } = page;

  const markup = renderToStaticMarkup(
    createElement(Render, {
      tree,
      assets,
      ...(source.data ? { data: source.data } : {}),
      ...(source.origin ? { origin: source.origin } : {}),
      ...(source.timeZone ? { timeZone: source.timeZone } : {}),
      ...(fluid ? {} : { width }),
    }),
  );

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${width}" />
<style>
${FONT_FACE_CSS}
${css}
${baseStyles()}
html, body { margin: 0; padding: 0; background: ${source.background ?? "#ffffff"}; }
${fluid ? "" : `body { width: ${width}px; }`}
</style>
</head>
<body>
${markup}
</body>
</html>`;

  return { html, width, ...(page.binding ? { binding: page.binding } : {}) };
}

// ---------------------------------------------------------------------------
// package assets
// ---------------------------------------------------------------------------

/**
 * The renderer package root, located by landmark rather than by counting `..`.
 *
 * Same reasoning as the harness: the number of levels between this file and the
 * package root differs between running from source and running from a bundle,
 * and getting it wrong renders a layout-free page in a fallback font rather
 * than failing.
 */
function rendererRoot(): string {
  const require = createRequire(import.meta.url);
  // `./styles.css` is in the package's `exports`, so it resolves where
  // `package.json` would not.
  let dir = dirname(require.resolve("@fanos/renderer/styles.css"));

  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "public")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("preview: could not locate the @fanos/renderer package root");
}

let cachedRoot: string | null = null;

function packageRoot(): string {
  cachedRoot ??= rendererRoot();
  return cachedRoot;
}

/**
 * The renderer's base stylesheet. `dist/` first: that is what ships, and the
 * harness makes the same choice for the same reason. Missing base styles are
 * not survivable — overlay layering and anchor placement live there — so this
 * throws rather than rendering a subtly different page.
 */
function baseStyles(): string {
  const root = packageRoot();
  const path = [join(root, "dist/styles.css"), join(root, "src/styles.css")].find((p) =>
    existsSync(p),
  );
  if (!path) {
    throw new Error(
      "preview: @fanos/renderer base stylesheet not found — run `pnpm --filter @fanos/renderer build`",
    );
  }
  return readFileSync(path, "utf8");
}

/**
 * Resolve a `/public/...` URL to a file inside the renderer package.
 *
 * The emitted CSS asks for `/public/fonts/...` and `/public/local/textures/...`
 * verbatim, so serving the directory at that exact path means no URL rewriting
 * — and no class of bug where a rewrite misses one prefix.
 *
 * Returns null for anything that escapes the directory.
 */
export function resolvePublicAsset(urlPath: string): { path: string; type: string } | null {
  const relative = decodeURIComponent(urlPath.replace(/^\/public\//, ""));
  const base = join(packageRoot(), "public");
  const path = resolve(base, normalize(relative));

  if (!path.startsWith(base + sep)) return null;
  if (!existsSync(path)) return null;

  return { path, type: contentType(path) };
}

const TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".css": "text/css",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? TYPES[path.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/** Only used to keep the bundler honest about this file being server-side. */
export const PREVIEW_MODULE = fileURLToPath(import.meta.url);
