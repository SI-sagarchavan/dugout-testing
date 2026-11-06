import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approve,
  defineTool,
  type ModelClient,
  type ModelRequest,
  type RunCheckpoint,
  type RunContext,
  type RunEvent,
  reject,
} from "@dugout/contracts";
import {
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  RunInterrupted,
  type ScriptStep,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import type { McpHost } from "@dugout/mcp";
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { type AnyAgent, agentToolName, childRunId, defineAgent } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

let dir: string;
let runsDir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdk-subagents-"));
  runsDir = await mkdtemp(join(tmpdir(), "runs-"));
});

const CHILD = "You are the researcher.";
const PARENT = "You are the lead.";

/** What the researcher's lookup tool saw, so a test can check the tenant it ran under. */
const looked: Array<{ tenantId: string; runId: string; depth?: number | undefined }> = [];

const researcher = (extra: { write?: boolean; agents?: AnyAgent[]; maxDepth?: number } = {}) =>
  defineAgent({
    spec: {
      id: "researcher",
      version: 1,
      owner: "test",
      description: "Finds the answer to one question.",
      instructions: CHILD,
      tools: ["facts.lookup", ...(extra.write ? ["facts.save"] : [])],
      skills: [],
      onDemandSkills: [],
      model: "nova-lite",
      memory: { read: [], write: [] },
      budget: { usdPerRun: 0.5, maxSteps: 4, maxDepth: extra.maxDepth ?? 0 },
      approvals: [],
    },
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    ...(extra.agents ? { agents: extra.agents } : {}),
    dir,
    tools: () => [
      defineTool({
        name: "facts.lookup",
        description: "Looks a fact up.",
        input: z.object({}),
        effect: "read",
        timeoutMs: 1_000,
        async run(_input, ctx) {
          looked.push({ tenantId: ctx.tenantId, runId: ctx.runId, depth: ctx.depth });
          return { fact: "the opener is on Friday" };
        },
      }),
      defineTool({
        name: "facts.save",
        description: "Saves a fact.",
        input: z.object({}),
        effect: "write",
        timeoutMs: 1_000,
        run: async () => ({ saved: true }),
      }),
    ],
  });

const lead = (
  child: AnyAgent,
  budget: { usdPerRun?: number; maxDepth?: number; maxSteps?: number } = {},
) =>
  defineAgent({
    spec: {
      id: "lead",
      version: 1,
      owner: "test",
      instructions: PARENT,
      tools: [],
      skills: [],
      onDemandSkills: [],
      model: "nova-lite",
      memory: { read: [], write: [] },
      budget: {
        usdPerRun: budget.usdPerRun ?? 1,
        maxSteps: budget.maxSteps ?? 4,
        maxDepth: budget.maxDepth ?? 1,
      },
      approvals: [],
    },
    input: z.object({ topic: z.string() }),
    output: z.object({ summary: z.string() }),
    agents: [child],
    dir,
    tools: () => [],
  });

/** One scripted model for parent and child, each turn routed by whose system prompt it carries. */
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
  consolidate: false,
});
const never = async () => {
  throw new Error("no approval was expected");
};

const askThenSum = (): Record<string, ScriptStep[]> => ({
  [PARENT]: [
    {
      toolCalls: [{ name: "agent.researcher", arguments: { question: "When is the opener?" } }],
    },
    { toolCalls: [{ name: "final", arguments: { summary: "Friday" } }] },
  ],
  [CHILD]: [
    { toolCalls: [{ name: "facts.lookup", arguments: {} }] },
    { toolCalls: [{ name: "final", arguments: { answer: "Friday" } }] },
  ],
});

describe("subagents (ADR 0025)", () => {
  it("names the tool after the agent, and a child's run id after the call", () => {
    expect(agentToolName("hook-maker")).toBe("agent.hookMaker");
    expect(childRunId("run-1", "call_1_0")).toBe(childRunId("run-1", "call_1_0"));
    expect(childRunId("run-1", "call_1_0")).not.toBe(childRunId("run-1", "call_2_0"));
    expect(childRunId("run-1", "call_1_0")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns the child's answer as the tool result, the child a run of its own", async () => {
    looked.length = 0;
    const client = routed(askThenSum());
    const sink = createMemorySink();
    const result = await lead(researcher()).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
      runId: "parent-1",
      sinks: [sink],
    });

    expect(result).toMatchObject({ status: "completed", output: { summary: "Friday" } });
    const childId = childRunId("parent-1", "call_1_0");
    // the child's answer, with its run id, is what the parent's model reads
    const answer = client.requests[3]?.messages.at(-1);
    expect(answer).toMatchObject({ role: "tool" });
    expect(JSON.parse(String(answer?.content))).toEqual({
      runId: childId,
      output: { answer: "Friday" },
    });
    // the child ran under the parent's tenant, one level down
    expect(looked).toEqual([{ tenantId: "club-a", runId: childId, depth: 1 }]);
    // its own events, in its own run, saying who started it
    const started = sink.events.find(
      (e): e is Extract<RunEvent, { type: "run.started" }> =>
        e.type === "run.started" && e.runId === childId,
    );
    expect(started?.data.parent).toEqual({ runId: "parent-1", callId: "call_1_0" });
  });

  it("runs the child on its own spec's model, or on the one the host named for the run", async () => {
    const own = routed(askThenSum());
    await lead(researcher()).create(deps(own))({
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
    });
    expect(new Set(own.requests.map((r) => r.model))).toEqual(new Set(["nova-lite"]));

    // --model is for the run's whole tree: the parent and the child both run on haiku
    const named = routed(askThenSum());
    await lead(researcher()).create(deps(named))({
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
      model: "haiku",
    });
    expect(named.requests).toHaveLength(4);
    expect(new Set(named.requests.map((r) => r.model))).toEqual(new Set(["haiku"]));
  });

  it("gives the child only its own input, never the parent's transcript", async () => {
    const client = routed(askThenSum());
    await lead(researcher()).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
    });
    const first = client.requests.find((r) => String(r.messages[0]?.content).startsWith(CHILD));
    expect(first?.messages).toHaveLength(2);
    expect(first?.messages[1]?.content).toBe(JSON.stringify({ question: "When is the opener?" }));
    expect(JSON.stringify(first?.messages)).not.toContain('the opener"}');
    // the parent's model is offered the child as a tool, the child's description and input
    const offered = client.requests[0]?.tools.find((t) => t.name === "agent.researcher");
    expect(offered?.description).toBe("Finds the answer to one question.");
    expect(offered?.parameters).toMatchObject({ properties: { question: { type: "string" } } });
  });

  it("counts what the child spends against the parent's budget", async () => {
    // each scripted turn is 1,200 tokens at $1 per million: $0.0012
    const turn = 0.0012;
    const client = routed(askThenSum());
    const sink = createMemorySink();
    const result = await lead(researcher()).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
      sinks: [sink],
    });
    // two parent turns and two child turns
    expect(result.usage.costUsd).toBeCloseTo(4 * turn, 6);
    expect(result.usage.steps).toBe(2);
    const done = sink.events.find(
      (e): e is Extract<RunEvent, { type: "tool.completed" }> =>
        e.type === "tool.completed" && e.data.tool === "agent.researcher",
    );
    expect(done?.data.usage?.costUsd).toBeCloseTo(2 * turn, 6);

    // a parent with less left than the child's own budget: the child stops at what is left
    const tight = routed(askThenSum());
    const capped = await lead(researcher(), { usdPerRun: 0.002 }).create(deps(tight))({
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
    });
    expect(capped).toMatchObject({ status: "failed", reason: "budget" });
  });

  it("resumes a parent that stopped mid-call without running the child again", async () => {
    const client = routed(askThenSum());
    const runs = createMemoryRunStore();
    // the process is lost right after the child answered, before the parent saved the answer
    let lost = false;
    const flaky = {
      ...runs,
      async save(
        ctx: RunContext,
        checkpoint: RunCheckpoint,
        appended: Parameters<typeof runs.save>[2],
      ) {
        if (!lost && ctx.runId === "parent-2" && checkpoint.savedAfter === "tool") {
          lost = true;
          throw new RunInterrupted("the worker went away");
        }
        return runs.save(ctx, checkpoint, appended);
      },
    };
    const run = lead(researcher()).create(deps(client));
    const opts = {
      tenantId: "club-a",
      input: { topic: "the opener" },
      responder: never,
      runId: "parent-2",
      store: flaky,
    };
    await expect(run(opts)).rejects.toThrow(RunInterrupted);
    const childTurns = () =>
      client.requests.filter((r) => String(r.messages[0]?.content).startsWith(CHILD)).length;
    expect(childTurns()).toBe(2);

    const result = await run({ ...opts, resume: { reason: "recovery" } });
    expect(result).toMatchObject({ status: "completed", output: { summary: "Friday" } });
    // the child had ended: it answered from its save, with no turn of its own
    expect(childTurns()).toBe(2);
  });

  it("refuses a child below the depth the calling agent allows", async () => {
    // lead (depth 0) → researcher (1) → researcher (2), but the researcher allows only depth 1
    const inner = researcher();
    const middle = researcher({ agents: [inner], maxDepth: 1 });
    const client = routed({
      [PARENT]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "q" } }] },
        { toolCalls: [{ name: "final", arguments: { summary: "s" } }] },
      ],
      [CHILD]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "deeper" } }] },
        { toolCalls: [{ name: "final", arguments: { answer: "a" } }] },
      ],
    });
    const result = await lead(middle, { maxDepth: 2 }).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: never,
    });
    expect(result.status).toBe("completed");
    const refusal = client.requests[2]?.messages.at(-1);
    expect(refusal).toMatchObject({ role: "tool", isError: true });
    expect(String(refusal?.content)).toContain("would run 2 level(s) below");
  });

  it("keeps a record for a grandchild too: every level's `runs` row is opened", async () => {
    // lead → researcher → researcher. Without the host's recorder passed down, the grandchild has
    // no row, and writing its first event breaks the foreign key from `run_events` to `runs`.
    const opened: Array<{ runId: string; parent: { runId: string; callId: string } }> = [];
    const children = {
      open: async (o: (typeof opened)[number]) => {
        opened.push(o);
        return { lastSeq: 0 };
      },
    };
    const client = routed({
      [PARENT]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "q" } }] },
        { toolCalls: [{ name: "final", arguments: { summary: "s" } }] },
      ],
      // the middle researcher and the inner one share a prompt, so one script is read in turn
      [CHILD]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "deeper" } }] },
        { toolCalls: [{ name: "final", arguments: { answer: "inner" } }] },
        { toolCalls: [{ name: "final", arguments: { answer: "outer" } }] },
      ],
    });
    const middle = researcher({ agents: [researcher()], maxDepth: 2 });
    const result = await lead(middle, { maxDepth: 2 }).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: never,
      runId: "parent-g",
      children,
    });
    expect(result.status).toBe("completed");
    const middleId = childRunId("parent-g", "call_1_0");
    expect(opened.map((o) => o.parent.runId)).toEqual(["parent-g", middleId]);
    expect(opened).toHaveLength(2);
  });

  it("brings a grandchild's questions up to the run a host follows, and its answers back down (ADR 0029)", async () => {
    // lead → researcher → researcher, and the innermost asks a person
    const runStore = createMemoryRunStore();
    const question = {
      id: "source",
      question: "Which fixtures feed?",
      why: "Two hooks fit",
      kind: "choice" as const,
      options: [
        { value: "by_day", label: "By day", description: "" },
        { value: "carousel", label: "Carousel", description: "" },
      ],
      allowOther: false,
      proposed: ["by_day"],
    };
    const tree = () => lead(researcher({ agents: [researcher()], maxDepth: 2 }), { maxDepth: 2 });
    const first = await tree().create(
      deps(
        routed({
          [PARENT]: [{ toolCalls: [{ name: "agent.researcher", arguments: { question: "q" } }] }],
          [CHILD]: [
            { toolCalls: [{ name: "agent.researcher", arguments: { question: "deeper" } }] },
            { toolCalls: [{ name: "ask", arguments: { questions: [question] } }] },
          ],
        }),
      ),
    )({
      tenantId: "club-a",
      input: { topic: "t" },
      // the host answers later: the run is saved as waiting, as the worker's runs are
      responder: async () => ({ pending: true }),
      runId: "ask-top",
      store: runStore,
      sinks: [createMemorySink()],
    });

    const middleId = childRunId("ask-top", "call_1_0");
    const innerId = childRunId(middleId, "call_1_0");
    expect(first).toMatchObject({
      status: "waiting",
      waiting: {
        tool: "agent.researcher",
        questions: [{ id: "source" }],
        from: [middleId, innerId],
      },
    });

    // the person answers on the top run; it resumes, and the answer reaches the one that asked
    const client = routed({
      [PARENT]: [{ toolCalls: [{ name: "final", arguments: { summary: "carousel feed" } }] }],
      [CHILD]: [
        { toolCalls: [{ name: "final", arguments: { answer: "inner: carousel" } }] },
        { toolCalls: [{ name: "final", arguments: { answer: "middle: carousel" } }] },
      ],
    });
    const sink = createMemorySink();
    const second = await tree().create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: never,
      runId: "ask-top",
      store: runStore,
      sinks: [sink],
      resume: {
        reason: "answered",
        decision: { by: "editor", answers: { source: "carousel" } },
      },
    });
    expect(second).toMatchObject({ status: "completed", output: { summary: "carousel feed" } });
    // the innermost model read the answer as the result of its ask
    const innerRead = client.requests.find((r) =>
      r.messages.some((m) => m.role === "tool" && m.content.includes('"answer":"carousel"')),
    );
    expect(innerRead).toBeDefined();
    const answeredAt = sink.events
      .filter((e) => e.type === "question.answered")
      .map((e) => e.runId);
    expect(answeredAt).toEqual(["ask-top", middleId, innerId]);
  });

  it("refuses to load an agent that calls agents with no depth for one", () => {
    expect(() => lead(researcher(), { maxDepth: 0 })).toThrow(/budget.maxDepth must be 1 or more/);
  });

  it("asks a person once for a child that writes, and the child's writes go through under that yes", async () => {
    const client = routed({
      [PARENT]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "Save it" } }] },
        { toolCalls: [{ name: "final", arguments: { summary: "saved" } }] },
      ],
      [CHILD]: [
        { toolCalls: [{ name: "facts.save", arguments: {} }] },
        { toolCalls: [{ name: "final", arguments: { answer: "saved" } }] },
      ],
    });
    const asked: string[] = [];
    const sink = createMemorySink();
    const result = await lead(researcher({ write: true })).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
      runId: "parent-w",
      sinks: [sink],
    });
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    // the person was asked about the call to the child, not about the child's own write
    expect(asked).toEqual(["agent.researcher"]);
    const granted = sink.events.filter(
      (e): e is Extract<RunEvent, { type: "question.answered" }> => e.type === "question.answered",
    );
    expect(granted.map((e) => [e.runId, e.data.tool, e.data.by])).toEqual([
      ["parent-w", "agent.researcher", "editor"],
      [
        // a child that writes is named after its agent, not the call: it runs once per run
        childRunId("parent-w", "once:researcher"),
        "facts.save",
        // said as a host's answer, not a person's: it was the parent's yes that let it through
        "the call that started this run (parent-w call_1_0) (auto)",
      ],
    ]);
  });

  it("treats a child as writing when a capability, not its spec, gives it the write tool (ADR 0026)", async () => {
    const saved: string[] = [];
    // an MCP host that resolves the child's capability to one write tool, as the registry does
    const mcp = {
      resolve: () => ({
        tools: [
          defineTool({
            name: "facts.save",
            description: "Saves a fact.",
            input: z.object({}),
            effect: "write",
            timeoutMs: 1_000,
            run: async () => void saved.push("saved"),
          }),
        ],
        instructions: "",
        approvals: [],
        servers: ["facts"],
      }),
    } as unknown as McpHost;
    const capable = defineAgent({
      spec: {
        id: "researcher",
        version: 1,
        owner: "test",
        description: "Finds the answer to one question.",
        instructions: CHILD,
        tools: [],
        requires: ["facts.write"],
        skills: [],
        onDemandSkills: [],
        model: "nova-lite",
        memory: { read: [], write: [] },
        budget: { usdPerRun: 0.5, maxSteps: 4, maxDepth: 0 },
        approvals: [],
      },
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      dir,
      tools: () => [],
    });
    const client = routed({
      [PARENT]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "Save it" } }] },
        { toolCalls: [{ name: "final", arguments: { summary: "saved" } }] },
      ],
      [CHILD]: [
        { toolCalls: [{ name: "facts.save", arguments: {} }] },
        { toolCalls: [{ name: "final", arguments: { answer: "saved" } }] },
      ],
    });
    const asked: string[] = [];
    const result = await lead(capable).create({ ...deps(client), mcp })({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
    });
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    // the call to the child is the write a person approves, and the child's write goes through under it
    expect(asked).toEqual(["agent.researcher"]);
    expect(saved).toEqual(["saved"]);
  });

  it("refuses a parent's call to a writing child when the person says no, and the child never runs", async () => {
    const client = routed({
      [PARENT]: [{ toolCalls: [{ name: "agent.researcher", arguments: { question: "Save it" } }] }],
      [CHILD]: [],
    });
    const result = await lead(researcher({ write: true })).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: async () => reject("editor", "not now"),
    });
    expect(result.status).toBe("rejected");
    expect(
      client.requests.filter((r) => String(r.messages[0]?.content).startsWith(CHILD)),
    ).toHaveLength(0);
  });

  it("builds one thing per run: once a try completed, a second call is refused with what it built", async () => {
    const client = routed({
      [PARENT]: [
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "Save it" } }] },
        { toolCalls: [{ name: "agent.researcher", arguments: { question: "Save it, again" } }] },
        { toolCalls: [{ name: "final", arguments: { summary: "saved" } }] },
      ],
      [CHILD]: [
        { toolCalls: [{ name: "facts.save", arguments: {} }] },
        { toolCalls: [{ name: "final", arguments: { answer: "saved once" } }] },
      ],
    });
    const runs = createMemoryRunStore();
    const asked: string[] = [];
    const result = await lead(researcher({ write: true })).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
      runId: "parent-once",
      store: runs,
    });
    expect(result.status).toBe("completed");
    // the child ran once, and a person was asked once: the second call never reached either
    const childTurns = client.requests.filter((r) =>
      String(r.messages[0]?.content).startsWith(CHILD),
    );
    expect(childTurns).toHaveLength(2);
    expect(asked).toEqual(["agent.researcher"]);
    const second = client.requests.at(-1)?.messages.findLast((m) => m.role === "tool");
    expect(String(second?.content)).toContain("already completed in this run");
    expect(String(second?.content)).toContain('{"answer":"saved once"}');
    // the child's spend is counted once
    expect(result.usage.costUsd).toBeCloseTo(5 * 0.0012, 6);
    // the tool says so to the model
    expect(
      client.requests[0]?.tools.find((t) => t.name === "agent.researcher")?.description,
    ).toContain("builds one thing per run");
  });

  /** Four refused finals in a row: the child runs out of its four steps and fails. */
  const FAILS = Array.from({ length: 4 }, () => ({
    toolCalls: [{ name: "final", arguments: { wrong: true } }],
  }));
  const call = (question: string) => ({
    toolCalls: [{ name: "agent.researcher", arguments: { question } }],
  });

  it("lets a failed try be made again, each a call a person approves and is shown the failure for", async () => {
    const client = routed({
      [PARENT]: [
        call("Save it"),
        call("Save it, with what the failure said"),
        { toolCalls: [{ name: "final", arguments: { summary: "saved" } }] },
      ],
      [CHILD]: [...FAILS, { toolCalls: [{ name: "final", arguments: { answer: "second try" } }] }],
    });
    const asked: Array<{ tool: string; input: unknown }> = [];
    const sink = createMemorySink();
    const result = await lead(researcher({ write: true })).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: async (req) => {
        asked.push({ tool: req.tool, input: req.input });
        return approve("editor");
      },
      runId: "parent-retry",
      store: createMemoryRunStore(),
      sinks: [sink],
    });
    expect(result).toMatchObject({ status: "completed", output: { summary: "saved" } });
    // the first call is shown plain; the repeat says which try it is and what the last one failed on
    expect(asked).toHaveLength(2);
    expect(asked[0]?.input).toEqual({ question: "Save it" });
    expect(asked[1]?.input).toMatchObject({
      question: "Save it, with what the failure said",
      retry: { attempt: 2, of: 3, lastFailure: expect.stringContaining("invalid_output") },
    });
    // each try is a child of its own: the first keeps its id, the next is named for its number
    const started = sink.events
      .filter((e) => e.type === "run.started" && e.runId !== "parent-retry")
      .map((e) => e.runId);
    expect(started).toEqual([
      childRunId("parent-retry", "once:researcher"),
      childRunId("parent-retry", "once:researcher:2"),
    ]);
    // the failure reached the model, saying a person approves the next try
    const failedAnswer = client.requests
      .flatMap((r) => r.messages)
      .find((m) => m.role === "tool" && String(m.content).includes("Try 1 of 3"));
    expect(String(failedAnswer?.content)).toContain("a person approves that");
    // the child never saw the retry note
    const secondChild = client.requests.filter((r) =>
      String(r.messages[0]?.content).startsWith(CHILD),
    )[4];
    expect(String(secondChild?.messages[1]?.content)).not.toContain("retry");
  });

  it("stops after three failed tries and says a person has to look, without asking one to approve a fourth", async () => {
    const client = routed({
      [PARENT]: [
        call("one"),
        call("two"),
        call("three"),
        call("four"),
        { toolCalls: [{ name: "final", arguments: { summary: "gave up" } }] },
      ],
      [CHILD]: [...FAILS, ...FAILS, ...FAILS],
    });
    const asked: string[] = [];
    const result = await lead(researcher({ write: true }), { maxSteps: 8 }).create(deps(client))({
      tenantId: "club-a",
      input: { topic: "t" },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
      runId: "parent-stop",
      store: createMemoryRunStore(),
    });
    expect(result.status).toBe("completed");
    expect(asked).toEqual(["agent.researcher", "agent.researcher", "agent.researcher"]);
    const last = client.requests.at(-1)?.messages.findLast((m) => m.role === "tool");
    expect(String(last?.content)).toContain("failed 3 time(s) in this run and is not tried again");
    expect(String(last?.content)).toContain("a person has to look");
    // the third failure itself already said so
    const third = client.requests
      .flatMap((r) => r.messages)
      .find((m) => m.role === "tool" && String(m.content).includes("Try 3 of 3"));
    expect(String(third?.content)).toContain("a person has to look");
  });

  describe("a pipeline: agents run in a fixed order, in code", () => {
    const stage = (id: string, prefix: string, write: boolean) =>
      defineAgent({
        spec: {
          id,
          version: 1,
          owner: "test",
          description: `Stage ${id}.`,
          instructions: prefix,
          tools: write ? ["facts.save"] : [],
          skills: [],
          onDemandSkills: [],
          model: "nova-lite",
          memory: { read: [], write: [] },
          budget: { usdPerRun: 0.5, maxSteps: 4, maxDepth: 0 },
          approvals: [],
        },
        input: z.object({ question: z.string() }),
        output: z.object({ answer: z.string() }),
        dir,
        tools: () =>
          write
            ? [
                defineTool({
                  name: "facts.save",
                  description: "Saves a fact.",
                  input: z.object({}),
                  effect: "write",
                  timeoutMs: 1_000,
                  run: async () => ({ saved: true }),
                }),
              ]
            : [],
      });
    const ONE = "You are stage one.";
    const TWO = "You are stage two.";
    const FAILS2 = Array.from({ length: 4 }, () => ({
      toolCalls: [{ name: "final", arguments: { wrong: true } }],
    }));

    /** Built in the test, once `dir` exists. */
    const build = () => {
      const one = stage("stage-one", ONE, true);
      const two = stage("stage-two", TWO, true);
      return defineAgent({
        spec: {
          id: "piped",
          version: 1,
          owner: "test",
          instructions: PARENT,
          tools: [],
          skills: [],
          onDemandSkills: [],
          model: "nova-lite",
          memory: { read: [], write: [] },
          budget: { usdPerRun: 1, maxSteps: 6, maxDepth: 1 },
          approvals: [],
        },
        input: z.object({ topic: z.string() }),
        output: z.object({ summary: z.string() }),
        agents: [one, two],
        pipeline: {
          name: "page.build",
          description: "Runs stage one, then stage two on its answer.",
          async run(call, input) {
            const { topic } = input as { topic: string };
            const a = (await call(one, { question: topic })) as { answer: string };
            const b = (await call(two, { question: `after ${a.answer}` })) as { answer: string };
            return { first: a.answer, second: b.answer };
          },
        },
        dir,
        tools: () => [],
      });
    };
    const ok = (answer: string) => ({ toolCalls: [{ name: "final", arguments: { answer } }] });
    const callBuild = { toolCalls: [{ name: "page.build", arguments: {} }] };

    it("runs the stages in code, in order, as one tool a person approves once", async () => {
      const client = routed({
        [PARENT]: [callBuild, { toolCalls: [{ name: "final", arguments: { summary: "done" } }] }],
        [ONE]: [{ toolCalls: [{ name: "facts.save", arguments: {} }] }, ok("saved")],
        [TWO]: [ok("checked")],
      });
      const asked: string[] = [];
      const result = await build().create(deps(client))({
        tenantId: "club-a",
        input: { topic: "t" },
        responder: async (req) => {
          asked.push(req.tool);
          return approve("editor");
        },
        runId: "parent-pipe",
        store: createMemoryRunStore(),
      });
      expect(result).toMatchObject({ status: "completed", output: { summary: "done" } });
      // one approval for the whole sequence, and the first stage's own write rode under it
      expect(asked).toEqual(["page.build"]);
      // stage two was given what stage one answered
      const second = client.requests.find((r) => String(r.messages[0]?.content).startsWith(TWO));
      expect(JSON.stringify(second?.messages[1]?.content)).toContain("after saved");
      // the model is offered the one tool, never a stage on its own
      const offered = client.requests[0]?.tools.map((t) => t.name);
      expect(offered).toContain("page.build");
      expect(offered).not.toContain("agent.stageOne");
      expect(offered).not.toContain("agent.stageTwo");
    });

    it("keeps a stage that completed when a later one fails, and tries only the failed one again", async () => {
      const client = routed({
        [PARENT]: [
          callBuild,
          callBuild,
          { toolCalls: [{ name: "final", arguments: { summary: "done" } }] },
        ],
        [ONE]: [{ toolCalls: [{ name: "facts.save", arguments: {} }] }, ok("saved")],
        [TWO]: [...FAILS2, ok("checked")],
      });
      const asked: Array<{ tool: string; input: unknown }> = [];
      const result = await build().create(deps(client))({
        tenantId: "club-a",
        input: { topic: "t" },
        responder: async (req) => {
          asked.push({ tool: req.tool, input: req.input });
          return approve("editor");
        },
        runId: "parent-pipe-retry",
        store: createMemoryRunStore(),
      });
      expect(result).toMatchObject({ status: "completed", output: { summary: "done" } });
      expect(asked).toHaveLength(2);
      expect(asked[0]?.input).toEqual({});
      // the repeat says which stage failed and what it failed on
      expect(asked[1]?.input).toMatchObject({
        retry: { stage: "stage-two", attempt: 2, of: 3, lastFailure: expect.any(String) },
      });
      // stage one ran once: the second call found it done
      const oneTurns = client.requests.filter((r) =>
        String(r.messages[0]?.content).startsWith(ONE),
      );
      expect(oneTurns).toHaveLength(2);
    });
  });
});
