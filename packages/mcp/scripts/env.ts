import { join } from "node:path";
import { REPO_ROOT } from "../src/registry.ts";

/** The repo's .env, wherever the script runs from; variables already set win. */
export function loadRepoEnv(): void {
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env"));
  } catch {
    // no .env: the variables may already be set
  }
}
