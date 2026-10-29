import { defineConfig } from "vitest/config";

// The tests run a worker, which claims any queued run in its database, so they get one of their own.
export default defineConfig({
  test: { globalSetup: ["./tests/setup.ts"], fileParallelism: false },
});
