import type { ToolTable } from "./tools.ts";

/** `pnpm agent <tool>`: what is started through the terminal host's entry point. */
export const AGENT_TOOLS: ToolTable = {
  watch: "apps/cli/scripts/figma-watch.ts",
  schemas: "packages/sdk/scripts/schemas.ts",
  "memory review": "packages/memory/scripts/review.ts",
  "memory promote": "packages/memory/scripts/promote.ts",
};

/** `pnpm eval <tool>`: measuring and checking tools that are not suites. */
export const EVAL_TOOLS: ToolTable = {
  smoke: "packages/core/scripts/smoke.ts",
  measure: "agents/card-match/scripts/measure.ts",
  vision: "agents/card-match/scripts/vision-bench.ts",
  layout: "agents/card-match/scripts/layout-eval.ts",
};
