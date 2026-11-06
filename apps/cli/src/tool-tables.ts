import type { ToolTable } from "./tools.ts";

/** `pnpm agent <tool>`: what is started through the terminal host's entry point. */
export const AGENT_TOOLS: ToolTable = {
  watch: "apps/cli/scripts/figma-watch.ts",
  schemas: "packages/sdk/scripts/schemas.ts",
  "memory review": "packages/memory/scripts/review.ts",
  "memory promote": "packages/memory/scripts/promote.ts",
  "memory answers": "packages/memory/scripts/answers.ts",
  "library index": "packages/library/scripts/index.ts",
  "library search": "packages/library/scripts/search.ts",
  "library share": "packages/library/scripts/share.ts",
  "library previews": "packages/library/scripts/previews.ts",
  "mcp list": "packages/mcp/scripts/list.ts",
  "mcp sync": "packages/mcp/scripts/sync.ts",
  "mcp login": "packages/mcp/scripts/login.ts",
};

/** `pnpm eval <tool>`: measuring and checking tools that are not suites. */
export const EVAL_TOOLS: ToolTable = {
  smoke: "packages/core/scripts/smoke.ts",
  measure: "agents/frame-match/scripts/measure.ts",
  vision: "agents/frame-match/scripts/vision-bench.ts",
  layout: "agents/frame-match/scripts/layout-eval.ts",
  binding: "agents/frame-match/scripts/binding-experiment.ts",
};
