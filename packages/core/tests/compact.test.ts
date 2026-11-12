import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSpec,
  approve,
  defineTool,
  type ModelClient,
  type RunEvent,
  type Tool,
} from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compactedView,
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  runLocal,
  type ScriptStep,
  scriptedModelConfig,
} from "../src/index.ts";

const bigRead = defineTool({
  name: "big.read",
  description: "A result of 10k characters",
  input: z.object({ n: z.number() }),
  effect: "read",
  timeoutMs: 1_000,
  run: async ({ n }) => `result ${n} ${"x".repeat(10_000)}`,
});

const spec: AgentSpec = {
  id: "compact-agent",
  version: 1,
  owner: "tests",
  instructions: "You are a test agent.",
  tools: ["big.read"],
  skills: [],
  onDemandSkills: [],
  model: "nova-lite",
  memory: { read: [], write: [] },
  budget: { usdPerRun: 1, maxSteps: 20, maxDepth: 0 },
  approvals: [],
};

const reads = Array.from({ length: 8 }, (_, n) => ({
  toolCalls: [{ name: "big.read", arguments: { n } }],
}));
const script = [...reads, { toolCalls: [{ name: "final", arguments: { summary: "done" } }] }];

async function run(opts: {
  window: number;
  compaction?: false;
  summaryFails?: boolean;
  /** Compact past this many tokens, whatever the window. */
  maxTokens?: number;
  /** What the model says each request cost, when the estimate should not be the judge. */
  inputTokens?: number;
  tools?: Tool[];
  script?: ScriptStep[];
}) {
  const models = scriptedModelConfig();
  for (const m of Object.values(models.models)) m.contextWindow = opts.window;
  const scripted = createScriptedModel(opts.script ?? script);
  const summaries: string[] = [];
  const client: ModelClient = {
    async complete(req, ...rest) {
      if (req.model !== "haiku") {
        const turn = await scripted.complete(req, ...rest);
        return opts.inputTokens === undefined
          ? turn
          : { ...turn, tokens: { ...turn.tokens, inputTokens: opts.inputTokens } };
      }
      if (opts.summaryFails) throw new Error("no summary today");
      summaries.push(String(req.messages[1]?.content));
      return {
        message: {
          role: "assistant",
          content: "## Tried\nread results 0 to 3\n## Next\nread more",
        },
        tokens: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
        },
        servedModel: "haiku",
        finishReason: "stop",
      };
    },
  };
  const sink = createMemorySink();
  const store = createMemoryRunStore();
  const result = await runLocal({
    agent: {
      spec: opts.tools ? { ...spec, tools: opts.tools.map((t) => t.name) } : spec,
      output: z.object({ summary: z.string() }),
    },
    input: "Read them all",
    tenantId: "demo-cricket",
    runId: "r1",
    tools: opts.tools ?? [bigRead],
    client,
    models,
    responder: async () => approve("editor"),
    runsDir: await mkdtemp(join(tmpdir(), "dugout-compact-")),
    sinks: [sink],
    outputs: createMemoryOutputStore(),
    store,
    // a model of its own, so the fake client can tell a summary from the run's turns
    compaction:
      opts.compaction === false
        ? false
        : { summarizer: "haiku", ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) },
  });
  return { result, events: sink.events, scripted, summaries, store };
}

const compacted = (events: RunEvent[]) => events.filter((e) => e.type === "context.compacted");

describe("compaction", () => {
  it("lets a run that would fill the window finish, and says so in the stream", async () => {
    const { result, events, scripted, summaries } = await run({ window: 12_000 });
    expect(result.status).toBe("completed");
    const seen = compacted(events);
    expect(seen.length).toBeGreaterThan(0);
    const data = seen.at(-1)?.data as { tokensBefore: number; tokensAfter: number };
    expect(data.tokensAfter).toBeLessThan(data.tokensBefore);
    // older results became references, older turns a summary written by the cheap model
    expect(JSON.stringify(scripted.requests.at(-1)?.messages)).toContain("State so far");
    expect(summaries.length).toBeGreaterThan(0);
    // the summary is not one of the run's own turns
    expect(events.filter((e) => e.type === "token" && e.data.text.includes("Tried"))).toEqual([]);
    expect((result as { usage: { steps: number } }).usage.steps).toBe(script.length);
  });

  it("never parts a tool call from its result", async () => {
    const { scripted } = await run({ window: 12_000 });
    for (const req of scripted.requests) {
      const ids = new Set<string>();
      for (const m of req.messages) {
        if (m.role === "assistant") for (const c of m.toolCalls ?? []) ids.add(c.id);
        if (m.role === "tool") expect(ids.has(m.toolCallId)).toBe(true);
      }
    }
  });

  it("leaves the transcript whole and saves how it was compacted, so a resume reads the same view", async () => {
    const { store, scripted } = await run({ window: 12_000 });
    const kept = store.runs.get("demo-cricket/r1");
    const transcript = kept?.messages ?? [];
    const cp = kept?.points.at(-1)?.checkpoint;
    expect(cp?.compacted?.summary).toContain("Tried");
    expect(
      transcript.filter((m) => m.role === "tool").every((m) => m.content.includes("result")),
    ).toBe(true);
    const view = compactedView(transcript, cp?.compacted);
    expect(view.length).toBeLessThan(transcript.length);
    // the last request the model got was this view, plus the turn it was about to answer
    const lastRequest = scripted.requests.at(-1)?.messages ?? [];
    expect(JSON.stringify(view.slice(0, lastRequest.length))).toBe(JSON.stringify(lastRequest));
  });

  it("changes nothing for a run under 65% of the window", async () => {
    const roomy = await run({ window: 1_000_000 });
    const off = await run({ window: 1_000_000, compaction: false });
    expect(compacted(roomy.events)).toEqual([]);
    expect(JSON.stringify(roomy.scripted.requests)).toBe(JSON.stringify(off.scripted.requests));
  });

  it("compacts past a number of tokens, however large the window", async () => {
    // a million-token window is never 65% full within a run's budget
    const { result, events } = await run({ window: 1_000_000, maxTokens: 8_000 });
    expect(result.status).toBe("completed");
    expect(compacted(events).length).toBeGreaterThan(0);
  });

  it("goes by what the model counted, when that is more than the estimate", async () => {
    // by the estimate this run stays under the limit; the model says each request is far over
    const under = await run({ window: 1_000_000, maxTokens: 60_000 });
    expect(compacted(under.events)).toEqual([]);
    const over = await run({ window: 1_000_000, maxTokens: 60_000, inputTokens: 90_000 });
    expect(over.result.status).toBe("completed");
    expect(compacted(over.events).length).toBeGreaterThan(0);
  });

  it("writes the summary from the turns as they were, not from their references", async () => {
    const { summaries } = await run({ window: 12_000 });
    // a reference holds 300 characters of a result; the summariser reads far more of each
    expect(summaries[0]).toContain("x".repeat(3_000));
    expect(summaries[0]).not.toContain("Compacted to save room");
  });

  it("goes on with the references when the summary cannot be written", async () => {
    const { result, events, scripted } = await run({ window: 12_000, summaryFails: true });
    expect(result.status).toBe("completed");
    expect(compacted(events).length).toBeGreaterThan(0);
    const last = JSON.stringify(scripted.requests.at(-1)?.messages);
    expect(last).toContain("Call run.readOutput");
    expect(last).not.toContain("State so far");
  });
});

describe("a tool whose every result replaces the last", () => {
  const planTry = defineTool({
    name: "plan.try",
    description: "Tries the whole plan again",
    input: z.object({ n: z.number() }),
    effect: "read",
    timeoutMs: 1_000,
    // a try that applied nothing replaces nothing: what the last one said still holds
    latestOnly: (output) => !String(output).startsWith("not applied"),
    run: async ({ n }) => {
      if (n === 2) throw new Error("the plan does not parse");
      if (n === 4) return "not applied: the plan names no node";
      return `try ${n} ${"y".repeat(5_000)}`;
    },
  });
  const tries = [0, 1, 2, 3, 4].map((n) => ({
    toolCalls: [{ name: "plan.try", arguments: { n } }],
  }));
  const script = [
    ...tries,
    { toolCalls: [{ name: "big.read", arguments: { n: 9 } }] },
    { toolCalls: [{ name: "final", arguments: { summary: "done" } }] },
  ];
  const results = (messages: Array<{ role: string; content: string }>) =>
    messages.filter((m) => m.role === "tool").map((m) => m.content.slice(0, 40));

  it("leaves only the latest result in the request, and the rest by reference", async () => {
    const { result, events, scripted, store } = await run({
      window: 1_000_000,
      tools: [planTry, bigRead],
      script,
    });
    expect(result.status).toBe("completed");
    const last = results(scripted.requests.at(-1)?.messages ?? []);
    // tries 0 and 1 are references, the failed one stays (it is short), try 3 is whole (the try
    // after it applied nothing, so it still holds), and another tool's result is untouched
    expect(last[0]).toContain('"ref"');
    expect(last[1]).toContain('"ref"');
    expect(last[2]).toContain("the plan does not parse");
    expect(last[3]).toContain("try 3 yyy");
    expect(last[4]).toContain("not applied");
    expect(last[5]).toContain("result 9 xxx");
    expect(JSON.stringify(scripted.requests.at(-1)?.messages)).toContain(
      "Replaced by a later plan.try result",
    );
    // said in the stream, and the transcript keeps every result as it was
    expect(compacted(events).map((e) => (e.data as { elided: number }).elided)).toEqual([1, 1]);
    const transcript = store.runs.get("demo-cricket/r1")?.messages ?? [];
    expect(results(transcript).filter((c) => c.startsWith("try"))).toHaveLength(3);
  });

  it("changes nothing when compaction is off", async () => {
    const { scripted } = await run({
      window: 1_000_000,
      compaction: false,
      tools: [planTry, bigRead],
      script,
    });
    expect(JSON.stringify(scripted.requests.at(-1)?.messages)).not.toContain('"ref"');
  });
});
