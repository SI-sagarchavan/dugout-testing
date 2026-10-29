import { defineConfig } from "vitest/config";

export default defineConfig({ test: { globalSetup: ["@dugout/db/vitest-setup"] } });
