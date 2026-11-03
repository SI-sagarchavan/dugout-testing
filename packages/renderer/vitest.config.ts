import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The package imports its own client entry by name (the "use client" boundary); tests run
    // the source.
    alias: { "@fanos/renderer/client": new URL("./src/client.tsx", import.meta.url).pathname },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
