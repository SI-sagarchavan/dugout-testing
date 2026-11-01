// pnpm db migrate [harness|fanos|all] | seed | import [source] [--force]
//   harness  dugout's database (the default); fanos  the pipeline's control plane (ADR 0021)
import { spawnSync } from "node:child_process";
import { runScript } from "../apps/cli/src/tools.ts";

const [command, ...rest] = process.argv.slice(2);
const usage = "usage: pnpm db migrate [harness|fanos|all] | seed | import [source] [--force]";
const sh = (cmd: string, args: string[]) => {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (command === "migrate") {
  const target = rest[0] ?? "harness";
  if (!["harness", "fanos", "all"].includes(target)) {
    console.error(usage);
    process.exit(2);
  }
  if (target !== "fanos") await runScript("packages/db/scripts/migrate.ts", []);
  if (target !== "harness") sh("pnpm", ["--filter", "@fanos/api", "db:migrate"]);
} else if (command === "seed") {
  await runScript("packages/sdk/scripts/seed.ts", []);
} else if (command === "import") {
  sh("scripts/pipeline-db.sh", ["import", ...rest]);
} else {
  console.error(usage);
  process.exit(2);
}
