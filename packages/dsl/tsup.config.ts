import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external: ["zod", "@fanos/tokens"],
  },
  {
    // the browser-safe part: binding and clocks, no tokens
    entry: ["src/runtime.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
    external: ["zod"],
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    external: ["zod", "@fanos/tokens"],
  },
]);
