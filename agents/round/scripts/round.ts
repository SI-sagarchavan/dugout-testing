// pnpm round --tenant demo-cricket [--fixture c-101 ...] [--channel social] [--brief "..."] [--yes] [--resume]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { agent as matchday } from "@dugout/agent-matchday";
import type { ApprovalDecision, ApprovalRequest } from "@dugout/contracts";
import { type ProgramCheckpoint, REPO_ROOT, runProgram } from "@dugout/core";
import { liveDeps } from "@dugout/sdk";
import { type Channel, defineRoundProgram, listFixtures, type RoundState } from "../src/round.ts";

const CHANNELS = new Set<Channel>(["social", "push", "headline"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant) {
    console.error(
      "Usage: pnpm round --tenant <id> [--fixture <id> ...] [--channel social|push|headline] [--brief <text>] [--yes] [--resume]",
    );
    process.exit(2);
  }
  const known = await listFixtures(args.tenant);
  const fixtures = args.fixtures.length ? args.fixtures : known;
  const missing = fixtures.filter((id) => !known.includes(id));
  if (missing.length) {
    console.error(`no fixture ${missing.join(", ")} for ${args.tenant}`);
    process.exit(2);
  }

  const dir = join(REPO_ROOT, ".runs", "rounds");
  const file = join(dir, `${args.tenant}.json`);
  const resume = args.resume ? await readCheckpoint(file) : undefined;
  const deps = liveDeps();
  const run = matchday.create({ ...deps, consolidate: true });
  const by = userInfo().username || "editor";
  const ask = approver(by, args.yes);
  const program = defineRoundProgram({
    fixtures,
    concurrency: args.yes ? 2 : 1,
    ...(args.brief ? { brief: args.brief } : {}),
    ...(args.channels.length ? { channels: args.channels } : {}),
  });

  console.log(`· round ${args.tenant}: ${fixtures.join(", ")}`);
  const { state, checkpoint } = await runProgram(program, {
    ...(resume ? { resume } : {}),
    save: async (saved) => {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(saved, null, 2));
    },
    onEvent: (event) => {
      if (event.type === "task.started")
        console.log(`· matchday ${event.taskId} (try ${event.attempt})`);
      if (event.type === "task.completed")
        console.log(`· matchday ${event.taskId} ${event.status}`);
    },
    tasks: async (req) => {
      const result = await run({
        tenantId: args.tenant as string,
        input: req.input as { fixtureId: string; brief?: string; channels?: Channel[] },
        approver: ask,
      });
      return { status: "completed", output: result };
    },
  });
  await deps.pool.end();

  console.log("");
  for (const pack of checkpointPacks(state)) {
    console.log(`── ${pack.fixtureId} ${pack.status}`);
  }
  console.log(`· slate saved to ${file}`);
  console.log(`· ${checkpoint.done.slate?.status ?? "unsaved"}`);
}

function checkpointPacks(state: RoundState) {
  return state.packs;
}

function approver(by: string, yes: boolean) {
  const rl = yes ? undefined : createInterface({ input: stdin, output: stdout });
  return async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const present = matchday.cli.present?.(req);
    console.log(present ?? `${req.tool}\n${JSON.stringify(req.input, null, 2)}`);
    if (yes || !rl) return { approved: true, by };
    const answer = (await rl.question("y approve · n reject · or the change you want\n> ")).trim();
    if (/^(y|yes)$/i.test(answer)) return { approved: true, by };
    if (/^(n|no)$/i.test(answer)) return { approved: false, by, reason: "rejected" };
    return { approved: false, by, changes: answer };
  };
}

async function readCheckpoint(file: string): Promise<ProgramCheckpoint<RoundState> | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  return JSON.parse(raw) as ProgramCheckpoint<RoundState>;
}

function parseArgs(argv: string[]) {
  const fixtures: string[] = [];
  const channels: Channel[] = [];
  let tenant = "";
  let brief: string | undefined;
  let yes = false;
  let resume = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--tenant") tenant = next();
    else if (arg === "--fixture") fixtures.push(next());
    else if (arg === "--brief") brief = next();
    else if (arg === "--channel") {
      const channel = next();
      if (!CHANNELS.has(channel as Channel))
        throw new Error(`channel must be social, push or headline`);
      channels.push(channel as Channel);
    } else if (arg === "--yes") yes = true;
    else if (arg === "--resume") resume = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return { tenant, fixtures, channels, brief, yes, resume };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
