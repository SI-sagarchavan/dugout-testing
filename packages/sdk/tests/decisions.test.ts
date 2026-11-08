// The case ADR 0033 started from (Nov 7 and Nov 8 on one frame): a person decided on one run which
// hook a section uses; the next run on the same section was asked again, proposed the other way.
// Now the decision is kept on the section, by the agent that asked, and proposed the next time.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ModelClient, type ModelRequest, type RunEvent } from "@dugout/contracts";
import {
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  type ScriptStep,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore, decisionKey } from "@dugout/memory";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

// an agent's folder: these test agents have no skills in it
const dir = tmpdir();
let runsDir: string;
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "runs-"));
});

const BINDER = "You are the binder.";
const BUILDER = "You are the builder.";
const SECTION = "s2:player-carousel";

const hookChoice = {
  id: "hook_choice",
  question: "The existing hook covers most of the card. Build a fuller one, or use it as it is?",
  why: "It gives names, roles, stats and captaincy; no photos",
  kind: "choice" as const,
  options: [
    { value: "build", label: "Build a fuller hook", description: "" },
    { value: "use_existing", label: "Use it as it is", description: "" },
  ],
  allowOther: false,
  proposed: ["build"],
};

const binder = defineAgent({
  spec: {
    id: "binder",
    version: 1,
    owner: "test",
    description: "Binds a section to data.",
    instructions: BINDER,
    tools: ["frame.open"],
    skills: [],
    onDemandSkills: [],
    model: "nova-lite",
    memory: { read: [], write: [] },
    budget: { usdPerRun: 0.5, maxSteps: 6, maxDepth: 0 },
    approvals: [],
    questions: { hook_choice: { scope: "section", about: "use the hook found or build one" } },
  },
  input: z.object({ handoff: z.string() }),
  output: z.object({ hook: z.string() }),
  dir,
  tools: () => [
    defineTool({
      name: "frame.open",
      description: "Loads the section.",
      input: z.object({}),
      effect: "read",
      timeoutMs: 1_000,
      async run(_input, ctx) {
        ctx.situate?.({ section: SECTION, name: "Frame 1984078918" });
        return { opened: true };
      },
    }),
  ],
});

const builder = defineAgent({
  spec: {
    id: "builder",
    version: 1,
    owner: "test",
    instructions: BUILDER,
    tools: [],
    skills: [],
    onDemandSkills: [],
    model: "nova-lite",
    memory: { read: [], write: [] },
    budget: { usdPerRun: 1, maxSteps: 4, maxDepth: 1 },
    approvals: [],
  },
  input: z.object({ handoff: z.string() }),
  output: z.object({ summary: z.string() }),
  agents: [binder],
  dir,
  tools: () => [],
});

function routed(scripts: Record<string, ScriptStep[]>): ModelClient & { requests: ModelRequest[] } {
  const clients = Object.fromEntries(
    Object.entries(scripts).map(([who, steps]) => [who, createScriptedModel(steps)]),
  );
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete(req, onToken, onToolInput) {
      const { signal: _, ...rest } = req;
      requests.push(structuredClone(rest));
      const system = String(req.messages[0]?.content ?? "");
      const who = Object.keys(clients).find((w) => system.startsWith(w));
      if (!who) throw new Error(`no script for ${system.slice(0, 40)}`);
      return (clients[who] as ModelClient).complete(req, onToken, onToolInput);
    },
  };
}

const deps = (client: ModelClient) => ({
  store,
  client,
  models: scriptedModelConfig(),
  runsDir,
  consolidate: true,
});

/** One Handoff of the section: the binder opens it and asks, and the run waits for a person. */
async function handoff(tenantId: string, runId: string) {
  const runStore = createMemoryRunStore();
  const sink = createMemorySink();
  const result = await builder.create(
    deps(
      routed({
        [BUILDER]: [{ toolCalls: [{ name: "agent.binder", arguments: { handoff: runId } }] }],
        [BINDER]: [
          { toolCalls: [{ name: "frame.open", arguments: {} }] },
          { toolCalls: [{ name: "ask", arguments: { questions: [hookChoice] } }] },
        ],
      }),
    ),
  )({
    tenantId,
    input: { handoff: runId },
    responder: async () => ({ pending: true }),
    runId,
    store: runStore,
    sinks: [sink],
  });
  const asked = sink.events.find((e) => e.type === "question.asked" && !e.child) as
    | Extract<RunEvent, { type: "question.asked" }>
    | undefined;
  return { result, runStore, events: sink.events, asked };
}

/** The person answers on the run the host follows; the run completes and is consolidated. */
async function answer(
  tenantId: string,
  runId: string,
  first: Awaited<ReturnType<typeof handoff>>,
  hook: string,
) {
  return builder.create(
    deps(
      routed({
        [BUILDER]: [{ toolCalls: [{ name: "final", arguments: { summary: hook } }] }],
        [BINDER]: [{ toolCalls: [{ name: "final", arguments: { hook } }] }],
      }),
    ),
  )({
    tenantId,
    input: { handoff: runId },
    responder: async () => {
      throw new Error("no approval was expected");
    },
    runId,
    store: first.runStore,
    sinks: [createMemorySink()],
    resume: {
      reason: "answered",
      decision: { by: "Sagar Chavan", answers: { hook_choice: hook } },
      events: first.events.filter((e) => !e.child),
    },
  });
}

describe("a decision on a section, the next time it is asked (ADR 0033)", () => {
  it("keeps the person's choice on the section under the agent that asked, and proposes it on the next Handoff", async () => {
    const tenant = `t-rep-${randomUUID().slice(0, 8)}`;

    // Nov 7: the binder asks which hook; the person picks the existing one
    const nov7 = await handoff(tenant, `nov7-${tenant}`);
    expect(nov7.result.status).toBe("waiting");
    expect(nov7.asked?.data.questions[0]).toMatchObject({
      proposed: ["build"],
      about: { agent: "binder", scope: "section", section: SECTION },
    });
    expect(nov7.asked?.data.questions[0]?.learned).toBeUndefined();
    const done = await answer(tenant, `nov7-${tenant}`, nov7, "use_existing");
    expect(done.status).toBe("completed");
    expect(done.afterRunError).toBeUndefined();

    const key = decisionKey("binder", "hook_choice", SECTION);
    expect(await store.decision(tenant, key)).toMatchObject({
      agentId: "binder",
      value: "use_existing",
      strength: 1,
    });

    // Nov 8: another Handoff of the same section; the question is proposed what the person chose
    const nov8 = await handoff(tenant, `nov8-${tenant}`);
    expect(nov8.asked?.data.questions[0]).toMatchObject({
      proposed: ["use_existing"],
      learned: { from: "decision", times: 1 },
    });
    // answered the same way, it is one decision seen twice, not two
    await answer(tenant, `nov8-${tenant}`, nov8, "use_existing");
    expect((await store.decision(tenant, key))?.strength).toBe(2);
    expect(await store.listDecisions(tenant)).toHaveLength(1);
  });
});
