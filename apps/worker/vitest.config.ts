import { defineConfig } from "vitest/config";

// Workers claim any queued run in their database, so these tests get one of their own.
export default defineConfig({
  test: { globalSetup: ["./tests/setup.ts"], fileParallelism: false },
});
