import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSpec,
  approve,
  defineTool,
  type ModelClient,
  type RunEvent,
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

async function run(opts: { window: number; compaction?: false; summaryFails?: boolean }) {
  const models = scriptedModelConfig();
  for (const m of Object.values(models.models)) m.contextWindow = opts.window;
  const scripted = createScriptedModel(script);
  const summaries: string[] = [];
  const client: ModelClient = {
    async complete(req, ...rest) {
      if (req.model !== "haiku") return scripted.complete(req, ...rest);
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
    agent: { spec, output: z.object({ summary: z.string() }) },
    input: "Read them all",
    tenantId: "demo-cricket",
    runId: "r1",
    tools: [bigRead],
    client,
    models,
    responder: async () => approve("editor"),
    runsDir: await mkdtemp(join(tmpdir(), "dugout-compact-")),
    sinks: [sink],
    outputs: createMemoryOutputStore(),
    store,
    // a model of its own, so the fake client can tell a summary from the run's turns
    compaction: opts.compaction === false ? false : { summarizer: "haiku" },
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

  it("goes on with the references when the summary cannot be written", async () => {
    const { result, events, scripted } = await run({ window: 12_000, summaryFails: true });
    expect(result.status).toBe("completed");
    expect(compacted(events).length).toBeGreaterThan(0);
    const last = JSON.stringify(scripted.requests.at(-1)?.messages);
    expect(last).toContain("Call run.readOutput");
    expect(last).not.toContain("State so far");
  });
});
