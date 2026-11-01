// Live smoke run against Bedrock: one read tool, then `final`. Exercises streaming, tool calls and
// usage. Run with `pnpm eval smoke [--model <name>]` (reads .env if present, for AWS_PROFILE and
// AWS_REGION); the model is a name in config/models.json and defaults to nova-lite.
import { existsSync } from "node:fs";
import { defineTool } from "@dugout/contracts";
import { z } from "zod";
import { createBedrockClient, loadModelConfig, modelEntry, runLocal } from "../src/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const fixtureGet = defineTool({
  name: "fixture.get",
  description: "Look up a fixture by id.",
  input: z.object({ fixtureId: z.string() }),
  effect: "read",
  timeoutMs: 5_000,
  async run({ fixtureId }) {
    return { fixtureId, home: "Lions", away: "Tigers", kickoffUtc: "2026-11-02T14:00:00Z" };
  },
});

const models = loadModelConfig();
const flag = process.argv.indexOf("--model");
const model = flag === -1 ? "nova-lite" : (process.argv[flag + 1] ?? "");
modelEntry(models, model);

const result = await runLocal({
  agent: {
    spec: {
      id: "smoke",
      version: 1,
      owner: "harness",
      instructions:
        "Look up the fixture with the fixture.get tool, then call final with a one-line headline and the kickoff time.",
      tools: ["fixture.get"],
      skills: [],
      onDemandSkills: [],
      model,
      memory: { read: [], write: [] },
      budget: { usdPerRun: 0.05, maxSteps: 4, maxDepth: 0 },
      approvals: [],
    },
    output: z.object({ headline: z.string(), kickoffUtc: z.string() }),
  },
  input: "Preview fixture f-1",
  tenantId: "smoke",
  tools: [fixtureGet],
  client: createBedrockClient({ models }),
  models,
  approver: async () => ({ approved: false, by: "smoke", reason: "smoke runs never write" }),
  sinks: [{ write: (e) => void (e.type !== "token" && console.log(`${e.seq} ${e.type}`)) }],
});

console.log(JSON.stringify(result, null, 2));
console.log(`events: .runs/${result.runId}/events.jsonl`);
process.exitCode = result.status === "completed" ? 0 : 1;
