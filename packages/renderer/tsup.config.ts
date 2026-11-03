import { defineConfig } from "tsup";

/**
 * Externals are shared across all three entries. `next` is gone — this package
 * no longer knows a framework exists; `apps/web` is the thing that does.
 */
const external = [
  "react",
  "react-dom",
  "react-dom/server",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@fanos/dsl",
  "@fanos/tokens",
  "playwright",
  "pixelmatch",
  "pngjs",
  "zod",
  "swiper",
  "swiper/react",
  "swiper/modules",
  // The client components live in their own entry, so the "use client" boundary survives the
  // build. Everything else imports them by package name and never bundles them.
  "@fanos/renderer/client",
];

const jsx = (options: { jsx?: string }) => {
  options.jsx = "automatic";
};

export default defineConfig([
  {
    // The SDK. Nothing here reaches Playwright — that separation is the point
    // of the split, so keep this entry free of harness imports.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external,
    esbuildOptions: jsx,
  },
  {
    // `@fanos/renderer/client`: the carousel's client root. Its "use client" must stay the
    // module's first statement for Next.js to see the boundary; esbuild keeps it. Swiper is loaded by a dynamic import, in
    // its own chunk, with the first carousel on a page.
    entry: ["src/client.tsx"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    splitting: true,
    external,
    esbuildOptions: jsx,
  },
  {
    // The acceptance harness, behind `@fanos/renderer/harness`.
    entry: ["src/harness.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "node22",
    external,
    esbuildOptions: jsx,
  },
  {
    // The `fos-render` CLI.
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    external,
    // Without this, esbuild emits React.createElement with no React import and
    // `fos-render png` dies with "React is not defined".
    esbuildOptions: jsx,
  },
]);
