// pnpm card --tenant demo-cricket --card fixture-rail --brief "..." [--figma <dsl.json> --screenshot <card.png>] [--attempts 3] [--yes] [--resume]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { EventSink, RunEvent } from "@dugout/contracts";
import { type ProgramCheckpoint, REPO_ROOT, runProgram } from "@dugout/core";
import { liveDeps } from "@dugout/sdk";
import { outline } from "../src/agent.ts";
import { checkCard, trialRoot } from "../src/dsl.ts";
import { EditBatchSchema } from "../src/edits.ts";
import { closeRenderBrowser, diffCard, loadFigma, unpaintedTypes } from "../src/pixels.ts";
import { type CardProgramState, DEFAULT_ATTEMPTS, defineCardProgram } from "../src/program.ts";
import { draftAgent, type RepairInput, repairAgent, repairDraft } from "../src/repair.ts";
import { CARDS_DIR, writeCard } from "../src/tools.ts";

const LIVE_TAIL = 64;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant || !args.cardId || !args.brief) {
    console.error(
      "Usage: pnpm card --tenant <id> --card <id> --brief <text> [--figma <dsl.json> --screenshot <card.png>] [--attempts 3] [--yes] [--resume]",
    );
    process.exit(2);
  }
  if (Boolean(args.figma) !== Boolean(args.screenshot)) {
    console.error("figma and screenshot are set together");
    process.exit(2);
  }

  const dir = join(REPO_ROOT, ".runs", "card-programs", args.tenant);
  const file = join(dir, `${args.cardId}.json`);
  const resume = args.resume ? await readCheckpoint(file) : undefined;
  const deps = liveDeps();
  const made = { ...deps, consolidate: false as const };
  const repair = repairAgent.create(made);
  const draft = draftAgent.create(made);
  const ask = approver(args.yes);
  const runId = `card-program-${args.cardId}`;
  const renderRoot = trialRoot();
  const input = {
    cardId: args.cardId,
    ...(args.figma ? { figma: args.figma } : {}),
    ...(args.screenshot ? { screenshot: args.screenshot } : {}),
  };
  const program = defineCardProgram(
    {
      cardId: args.cardId,
      brief: args.brief,
      maxAttempts: args.attempts,
      ...(args.figma ? { figma: args.figma } : {}),
      ...(args.screenshot ? { screenshot: args.screenshot } : {}),
    },
    {
      load: (fields) => loadFigma(fields),
      check: (tree, data) => {
        const check = checkCard(tree, data);
        const extra = unpaintedTypes(tree);
        if (extra.length === 0) return check;
        return {
          ok: false,
          issues: [
            ...check.issues,
            `Unpainted node types: ${extra.join(", ")}. Replace each with Stack, Box, Text, Image or Divider. Keep Button and Icon.`,
          ],
        };
      },
      diff: async (draft) => {
        const parsed = repairDraft({ status: "completed", output: draft }, draft.cardId);
        if (!parsed) {
          return {
            ok: false,
            message: "the tree is not a card",
            size: { render: null, screenshot: null },
            regions: [],
          };
        }
        return diffCard(parsed, { runId, input });
      },
      save: async (draft) => {
        const parsed = repairDraft({ status: "completed", output: draft }, draft.cardId);
        if (!parsed) throw new Error("the tree is not a card");
        await writeCard(renderRoot, CARDS_DIR, parsed, args.tenant, runId);
      },
      approve: async (draft) => {
        console.log(outline(draft));
        return ask();
      },
      take: (output, cardId) => {
        const result = output as { status?: string; output?: unknown } | null;
        if (
          result?.status !== "completed" ||
          result.output == null ||
          typeof result.output !== "object"
        ) {
          return undefined;
        }
        const batch = EditBatchSchema.safeParse(result.output);
        if (batch.success && (batch.data.edits.length > 0 || batch.data.data)) {
          return {
            edits: batch.data.edits,
            ...(batch.data.data ? { data: batch.data.data } : {}),
          };
        }
        const taken = repairDraft(output, cardId);
        return taken ? { tree: taken.tree, data: taken.data } : undefined;
      },
    },
  );

  console.log(
    `· card ${args.cardId}: load, check and diff are code; repair returns edits, at most ${args.attempts} times`,
  );
  try {
    const { state } = await runProgram(program, {
      ...(resume ? { resume } : {}),
      save: async (saved) => {
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(saved, null, 2));
      },
      onEvent: (event) => {
        if (event.type === "step.started" && !event.id.endsWith(":apply")) {
          console.log(`· ${event.id}`);
        }
        if (event.type === "task.started") console.log(`· ${event.taskId} started`);
        if (event.type === "task.completed") console.log(`· ${event.taskId} ${event.status}`);
      },
      tasks: async (req) => {
        const runner =
          req.agentId === draftAgent.spec.id
            ? draft
            : req.agentId === repairAgent.spec.id
              ? repair
              : undefined;
        if (!runner) throw new Error(`card program has no agent ${req.agentId}`);
        const result = await runner({
          tenantId: args.tenant,
          input: req.input as RepairInput,
          approver: async () => ({ approved: true, by: "card" }),
          sinks: [liveSink()],
        });
        return { status: "completed", output: result };
      },
    });
    console.log("");
    if (state.passed) {
      console.log("open http://localhost:3415");
      return;
    }
    if (state.error) console.error(state.error);
    if (state.report && state.report !== state.error) console.error(state.report);
    console.error(`· stopped after ${state.repairs} repairs`);
    process.exitCode = 1;
  } finally {
    await closeRenderBrowser();
    await deps.pool.end();
  }
}

/** One moving line while the model writes `final`. */
function liveSink(): EventSink {
  let tool = "";
  let text = "";
  let drawn = false;
  const finish = () => {
    if (!drawn) return;
    stdout.write("\n");
    tool = "";
    text = "";
    drawn = false;
  };
  return {
    write(event: RunEvent) {
      if (event.type === "tool.input.delta") {
        if (tool && tool !== event.data.tool) finish();
        tool = event.data.tool;
        text += event.data.text;
        const flat = text.replace(/\s+/g, " ");
        const tail = flat.length > LIVE_TAIL ? `…${flat.slice(-(LIVE_TAIL - 1))}` : flat;
        stdout.write(`\r\x1b[K· ${tool}  ${tail}`);
        drawn = true;
        return;
      }
      if (event.type === "token") {
        finish();
        stdout.write(event.data.text);
        return;
      }
      if (event.type === "run.failed") {
        finish();
        console.error(`· repair failed: ${event.data.message}`);
        return;
      }
      if (event.type === "tool.started" || event.type === "run.completed") finish();
    },
  };
}

function approver(yes: boolean) {
  const rl = yes ? undefined : createInterface({ input: stdin, output: stdout });
  return async () => {
    if (yes || !rl) return { approved: true };
    const answer = (await rl.question("y approve · n reject · or the change you want\n> ")).trim();
    if (/^(y|yes)$/i.test(answer)) return { approved: true };
    if (/^(n|no)$/i.test(answer)) return { approved: false };
    return { approved: false, changes: answer };
  };
}

async function readCheckpoint(
  file: string,
): Promise<ProgramCheckpoint<CardProgramState> | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as ProgramCheckpoint<CardProgramState>;
  if (typeof parsed.state?.repairs !== "number") return undefined;
  return parsed;
}

function parseArgs(argv: string[]) {
  let tenant = "";
  let cardId = "";
  let brief = "";
  let figma: string | undefined;
  let screenshot: string | undefined;
  let attempts = DEFAULT_ATTEMPTS;
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
    else if (arg === "--card" || arg === "--cardId") cardId = next();
    else if (arg === "--brief") brief = next();
    else if (arg === "--figma") figma = next();
    else if (arg === "--screenshot") screenshot = next();
    else if (arg === "--attempts") attempts = Number(next());
    else if (arg === "--yes") yes = true;
    else if (arg === "--resume") resume = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a whole number");
  }
  return { tenant, cardId, brief, figma, screenshot, attempts, yes, resume };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
