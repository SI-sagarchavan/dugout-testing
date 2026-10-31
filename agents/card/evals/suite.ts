import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient } from "@dugout/contracts";
import {
  type Approver,
  createBedrockClient,
  createMemorySink,
  createScriptedModel,
  loadModelConfig,
  type ModelConfig,
  scriptedModelConfig,
} from "@dugout/core";
import { type EvalSuite, endedGracefully, writesGated } from "@dugout/evals";
import type { MemoryStore } from "@dugout/memory";
import { seedHouseFacts } from "@dugout/sdk";
import {
  agent,
  type CardDraft,
  checkCard,
  previewPaths,
  sampleCard,
  spec,
  summarize,
} from "../src/index.ts";

export interface SuiteOptions {
  mode: "live" | "scripted";
  model?: string;
  store: MemoryStore;
  runsDir: string;
}

const cases = [
  {
    id: "sample-shape",
    kind: "standard" as const,
    tenant: "demo-cricket",
    cardId: "trial-card",
    brief: "A match card for Southern Brave against Birmingham Phoenix at the Ageas Bowl.",
  },
];

export async function createSuite(opts: SuiteOptions): Promise<EvalSuite<(typeof cases)[number]>> {
  await seedHouseFacts(opts.store, ["demo-cricket"]);
  const live = opts.mode === "live";
  let models: ModelConfig;
  let client: ModelClient | undefined;
  if (live) {
    models = loadModelConfig();
    client = createBedrockClient({ models });
  } else {
    models = scriptedModelConfig();
  }
  const approver: Approver = async () => ({ approved: true, by: "eval" });
  const { tree, data } = sampleCard() as { tree: CardDraft["tree"]; data: CardDraft["data"] };
  const known = { cardId: "trial-card", tree, data } satisfies CardDraft;

  return {
    agentId: spec.id,
    cases,
    async runCase(c) {
      const renderRoot = await mkdtemp(join(tmpdir(), "card-render-"));
      const cardsDir = await mkdtemp(join(tmpdir(), "card-runs-"));
      const sink = createMemorySink();
      const run = agent.create({
        store: opts.store,
        models,
        ...(client ? { client } : { client: scriptedWriter(known) }),
        ...(opts.model ? { model: opts.model } : {}),
        renderRoot,
        cardsDir,
        runsDir: opts.runsDir,
        consolidate: false,
      });
      const result = await run({
        tenantId: c.tenant,
        input: { cardId: c.cardId, brief: c.brief },
        approver,
        sinks: [sink],
      });
      const events = sink.events;
      const grades = [endedGracefully(events), writesGated(events, ["card.save"])];
      if (result.status === "completed") {
        const preview = previewPaths(renderRoot);
        const tree = JSON.parse(await readFile(preview.tree, "utf8"));
        const data = JSON.parse(await readFile(preview.data, "utf8"));
        const output = result.output as { cardId?: string };
        grades.push({
          grader: "card-valid",
          pass: checkCard(tree, data).ok && output.cardId === c.cardId,
          detail: output.cardId ?? "no card",
        });
      }
      return {
        grades,
        runIds: [result.runId],
        costUsd: result.usage.costUsd,
        servedModels: [
          ...new Set(
            events.flatMap((event) =>
              event.type === "step.completed" ? [event.data.servedModel] : [],
            ),
          ),
        ],
      };
    },
  };
}

function scriptedWriter(draft: CardDraft): ModelClient {
  return createScriptedModel([
    { toolCalls: [{ name: "card.draft", arguments: draft }] },
    { toolCalls: [{ name: "card.check", arguments: {} }] },
    { toolCalls: [{ name: "card.save", arguments: {} }] },
    { toolCalls: [{ name: "final", arguments: summarize(draft) }] },
  ]);
}
