import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/**
 * Studio, behind this site. The site owns :3000 because the Figma plugin's manifest allows only
 * that origin: its `/v1/*` calls and Studio's board are forwarded to Studio on :3001.
 */
const STUDIO = (process.env.FANOS_STUDIO_URL ?? "http://localhost:3001").replace(/\/+$/, "");

const base: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript-flavoured ESM, not prebuilt browser
  // bundles. `@fanos/renderer` is the SDK this app renders through.
  transpilePackages: ["@fanos/renderer", "@fanos/dsl", "@fanos/tokens"],
  // `public/` is the renderer's (a symlink). The emitted theme CSS asks for `/public/fonts/…` and
  // `/public/local/textures/…` verbatim, as the harness and Studio serve them, so the same URLs
  // resolve here without rewriting the CSS.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        { source: "/public/:path*", destination: "/:path*" },
        { source: "/v1/:path*", destination: `${STUDIO}/v1/:path*` },
      ],
      // Anything this site has no page for is Studio's: the board and its Vite assets.
      fallback: [{ source: "/:path*", destination: `${STUDIO}/:path*` }],
    };
  },
  // A compile preview through the plugin can take longer than the default 30 s.
  experimental: { proxyTimeout: 120_000 },
  // Source files use NodeNext-style `.js` import specifiers. Webpack does not
  // rewrite those to `.ts`/`.tsx` unless we tell it to.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".tsx", ".ts", ".jsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

/**
 * A production build gets its own folder. `pnpm build` runs `next build` while `pnpm dev` may be
 * serving from `.next`, and a build written over a running dev server's folder breaks every page
 * it has not compiled yet. `next build` and `next start` share `.next-build`; `next dev` keeps
 * `.next`.
 */
export default function config(phase: string): NextConfig {
  return { ...base, distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next" : ".next-build" };
}
