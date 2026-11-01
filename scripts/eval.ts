// pnpm eval <agent> ... runs an agent's eval suite; smoke, measure and vision are tools beside it
// (apps/cli/src/tool-tables.ts).
import { EVAL_TOOLS } from "../apps/cli/src/tool-tables.ts";
import { dispatch } from "../apps/cli/src/tools.ts";

await dispatch(EVAL_TOOLS, process.argv.slice(2), "packages/evals/scripts/eval.ts", "pnpm eval");
