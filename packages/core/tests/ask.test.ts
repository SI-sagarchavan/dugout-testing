import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSpec,
  AwaitingAnswers,
  approve,
  checkAnswers,
  type Decision,
  defineTool,
  type InterruptRequest,
  type Question,
  type RunCheckpoint,
  type RunStore,
  reviewQuestion,
  type Tool,
} from "@dugout/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  type Responder,
  runLocal,
  type ScriptStep,
  scriptedModelConfig,
} from "../src/index.ts";

/** A tool that cannot go on without a person's answer: it asks for the CMS domain. */
let domainRuns: Array<string | undefined>;
const domainQuestion: Question = {
  id: "image_domain",
  question: "Which domain serves the CMS images?",
  why: "The hook's image paths are relative (/static-assets/...)",
  kind: "choice",
  options: [
    { value: "https://www.southernbrave.co.uk", label: "southernbrave.co.uk", description: "" },
    { value: "https://cdn.example.com", label: "cdn.example.com", description: "" },
  ],
  allowOther: true,
  proposed: ["https://www.southernbrave.co.uk"],
};
const imagesBind = defineTool({
  name: "images.bind",
  description: "Binds the images",
  input: z.object({}),
  effect: "read",
  timeoutMs: 1_000,
  async run(_input, ctx) {
    const domain = ctx.answered?.answers.image_domain;
    domainRuns.push(typeof domain === "string" ? domain : undefined);
    if (typeof domain !== "string") throw new AwaitingAnswers([domainQuestion]);
    return { bound: `${domain}/static-assets/a.png` };
  },
});

/** A write, so it waits for a person's yes: the same pause, with a review question. */
const imagesSave = defineTool({
  name: "images.save",
  description: "Saves the images",
  input: z.object({}),
  effect: "write",
  timeoutMs: 1_000,
  async run() {
    return { saved: true };
  },
});

const spec = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "asking-agent",
  version: 1,
  owner: "tests",
  instructions: "You are a test agent.",
  tools: ["images.bind"],
  skills: [],
  onDemandSkills: [],
  model: "nova-lite",
  memory: { read: [], write: [] },
  budget: { usdPerRun: 1, maxSteps: 8, maxDepth: 0 },
  approvals: [],
  ...overrides,
});
const Output = z.object({ summary: z.string() });
const call = (name: string, args: unknown = {}) => ({ toolCalls: [{ name, arguments: args }] });
const final = (summary: string) => call("final", { summary });

const contentType: Question = {
  id: "content",
  question: "The design shows videos; the only hook returns articles. What should the cards show?",
  why: "dugout_cricket_south_coast_stories has no video URL or duration",
  kind: "choice",
  options: [
    { value: "articles", label: "Use the articles", description: "Bind what exists now" },
    { value: "build", label: "Build a video hook", description: "From cms-video-detail" },
  ],
  allowOther: false,
  proposed: ["build"],
};
const count: Question = {
  id: "cards",
  question: "How many cards?",
  why: "The hook returns 6 and the design shows 4",
  kind: "number",
  options: [],
  allowOther: false,
  proposed: ["4"],
};
const ask = (...questions: Question[]) => call("ask", { questions });

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "dugout-ask-"));
  domainRuns = [];
});

async function invoke(opts: {
  runId: string;
  store: RunStore;
  script: ScriptStep[];
  responder: Responder;
  resume?: Parameters<typeof runLocal>[0]["resume"];
  tools?: Tool[];
  specTools?: string[];
}) {
  const sink = createMemorySink();
  const model = createScriptedModel(opts.script);
  const result = await runLocal({
    agent: { spec: spec(opts.specTools ? { tools: opts.specTools } : {}), output: Output },
    input: "Bind the cards",
    tenantId: "demo-cricket",
    runId: opts.runId,
    tools: opts.tools ?? [imagesBind],
    client: model,
    models: scriptedModelConfig(),
    responder: opts.responder,
    runsDir,
    sinks: [sink],
    outputs: createMemoryOutputStore(),
    store: opts.store,
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  return { result, events: sink.events, model };
}

const asked: InterruptRequest[] = [];
const later: Responder = async (req) => {
  asked.push(req);
  return { pending: true };
};
const answer = (answers: Record<string, unknown>): { reason: "answered"; decision: Decision } => ({
  reason: "answered",
  decision: { by: "editor", answers: answers as never },
});
const lastToolResult = (requests: { messages: { role: string; content: string }[] }[]) =>
  JSON.parse(requests.at(-1)?.messages.at(-1)?.content ?? "null");

describe("a run that asks a person (ADR 0029)", () => {
  it("offers ask to every agent, beside final", async () => {
    const { model } = await invoke({
      runId: "t0",
      store: createMemoryRunStore(),
      script: [final("ok")],
      responder: later,
    });
    expect(model.requests[0]?.tools.map((t) => t.name)).toEqual([
      "images.bind",
      "run.readOutput",
      "ask",
      "final",
    ]);
  });

  it("waits on several questions, then gives the model every answer at once; and asks again", async () => {
    asked.length = 0;
    const store = createMemoryRunStore();
    const first = await invoke({
      runId: "q1",
      store,
      script: [ask(contentType, count)],
      responder: later,
    });

    expect(first.result).toMatchObject({ status: "waiting", waiting: { tool: "ask" } });
    const saved = store.runs.get("demo-cricket/q1")?.points.at(-1)?.checkpoint as RunCheckpoint;
    expect(saved.waiting?.questions?.map((q) => q.id)).toEqual(["content", "cards"]);
    expect(asked.at(-1)?.questions?.map((q) => q.id)).toEqual(["content", "cards"]);
    const askedEvent = first.events.find((e) => e.type === "question.asked");
    expect(askedEvent?.data).toMatchObject({ tool: "ask", from: [] });

    // the answers, submitted together; the model reads them as the result of its ask
    const second = await invoke({
      runId: "q1",
      store,
      script: [
        ask({
          ...count,
          id: "featured",
          question: "Feature the first card?",
          kind: "confirm",
          proposed: ["yes"],
        }),
      ],
      responder: later,
      resume: answer({ content: "articles", cards: 4 }),
    });
    expect(second.events.find((e) => e.type === "question.answered")?.data).toMatchObject({
      by: "editor",
      answers: { content: "articles", cards: 4 },
    });
    expect(lastToolResult(second.model.requests)).toEqual({
      answeredBy: "editor",
      answers: [
        { id: "content", question: contentType.question, answer: "articles" },
        { id: "cards", question: "How many cards?", answer: 4 },
      ],
    });
    // a second round: the run waits again, on the new question
    expect(second.result).toMatchObject({ status: "waiting", waiting: { tool: "ask" } });

    const third = await invoke({
      runId: "q1",
      store,
      script: [final("bound")],
      responder: later,
      resume: answer({ featured: false }),
    });
    expect(third.result).toMatchObject({ status: "completed", output: { summary: "bound" } });
  });

  it("runs a tool again with the answers when the tool itself asked", async () => {
    const store = createMemoryRunStore();
    const first = await invoke({
      runId: "q2",
      store,
      script: [call("images.bind")],
      responder: later,
    });
    expect(first.result).toMatchObject({ status: "waiting", waiting: { tool: "images.bind" } });
    expect(first.events.find((e) => e.type === "question.asked")?.data).toMatchObject({
      tool: "images.bind",
      questions: [{ id: "image_domain" }],
    });
    // the call stopped to ask: no result yet
    expect(first.events.map((e) => e.type)).not.toContain("tool.completed");

    const second = await invoke({
      runId: "q2",
      store,
      script: [final("bound")],
      responder: later,
      resume: answer({ image_domain: "https://cdn.example.com" }),
    });
    expect(second.result).toMatchObject({ status: "completed" });
    expect(domainRuns).toEqual([undefined, "https://cdn.example.com"]);
    const done = second.events.find((e) => e.type === "tool.completed");
    expect(done?.data).toMatchObject({ ok: true, tool: "images.bind" });
    expect(String((done?.data as { content?: string } | undefined)?.content)).toContain(
      "cdn.example.com/static-assets",
    );
  });

  it("takes every proposal when the host answers yes without answers (unattended)", async () => {
    const yes: Responder = async () => ({ by: "watch (auto)" });
    const { result, model, events } = await invoke({
      runId: "q3",
      store: createMemoryRunStore(),
      script: [ask(contentType, count), call("images.bind"), final("ok")],
      responder: yes,
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(events.find((e) => e.type === "question.answered")?.data).toMatchObject({
      by: "watch (auto)",
      answers: { content: "build", cards: 4 },
    });
    expect(domainRuns).toEqual([undefined, "https://www.southernbrave.co.uk"]);
    expect(model.requests).toHaveLength(3);
  });

  it("never ends the run on a question: answering nothing leaves the agent to decide", async () => {
    const store = createMemoryRunStore();
    await invoke({ runId: "q4", store, script: [ask(contentType)], responder: later });
    const second = await invoke({
      runId: "q4",
      store,
      script: [final("decided myself")],
      responder: later,
      // the person sent no answer to the question: it is skipped, not rejected
      resume: answer({}),
    });
    expect(second.result).toMatchObject({
      status: "completed",
      output: { summary: "decided myself" },
    });
    expect(lastToolResult(second.model.requests)).toEqual({
      answeredBy: "editor",
      answers: [{ id: "content", question: contentType.question, answer: null }],
      note: "A null answer was left open: decide it yourself, and say so in your result.",
    });
  });

  it("lets the agent decide when no answers are sent at all: each proposal is used", async () => {
    const store = createMemoryRunStore();
    await invoke({ runId: "q6", store, script: [ask(contentType, count)], responder: later });
    const second = await invoke({
      runId: "q6",
      store,
      script: [final("ok")],
      responder: later,
      resume: { reason: "answered", decision: { by: "editor" } },
    });
    expect(lastToolResult(second.model.requests).answers).toEqual([
      { id: "content", question: contentType.question, answer: "build" },
      { id: "cards", question: "How many cards?", answer: 4 },
    ]);
  });

  it("a write's review is answered by the same pause: approve, change or reject", async () => {
    const reviewed = async (decision: Decision) => {
      const store = createMemoryRunStore();
      const asked: InterruptRequest[] = [];
      const first = await invoke({
        runId: `w-${Math.random()}`,
        store,
        script: [call("images.save", {})],
        responder: async (req) => {
          asked.push(req);
          return { pending: true };
        },
        tools: [imagesSave],
        specTools: ["images.save"],
      });
      return { first, asked, store, decision };
    };
    const { first, asked } = await reviewed(approve("editor"));
    expect(first.result).toMatchObject({ status: "waiting", waiting: { tool: "images.save" } });
    expect(asked[0]?.questions.map((q) => [q.id, q.kind])).toEqual([["review", "review"]]);
    expect(asked[0]?.subject).toEqual({ input: {} });
    const event = first.events.find((e) => e.type === "question.asked");
    expect(event?.data).toMatchObject({ tool: "images.save", subject: { input: {} } });
  });

  it("refuses badly formed questions with the reason, and the run goes on", async () => {
    const { result, model } = await invoke({
      runId: "q5",
      store: createMemoryRunStore(),
      script: [ask({ ...contentType, options: [] }), final("gave up")],
      responder: later,
    });
    expect(result).toMatchObject({ status: "completed" });
    const refusal = model.requests[1]?.messages.at(-1);
    expect(refusal).toMatchObject({ role: "tool", isError: true });
    expect(String(refusal?.content)).toContain("give two or more options");
  });
});

describe("answers checked against their questions", () => {
  it("names what is missing or does not fit", () => {
    expect(checkAnswers([contentType, count], { content: "articles", cards: 4 })).toBeUndefined();
    // a question left out is skipped, a wrong answer is named, and an unknown question is refused
    expect(checkAnswers([contentType, count], { content: "podcasts" })).toBe(
      "content: the answer is not one of articles, build",
    );
    expect(checkAnswers([contentType, count], { cards: 4, extra: "x" })).toBe(
      "extra: no such question",
    );
    // with no answers at all the agent decides; a write's review always needs its own answer
    expect(checkAnswers([contentType, count], undefined)).toBeUndefined();
    const review = reviewQuestion("images.save");
    expect(checkAnswers([review], undefined)).toBe("review: no answer");
    expect(checkAnswers([review], { review: { decision: "reject" } })).toBe(
      "review: the answer needs a comment: why",
    );
    expect(checkAnswers([review], { review: { decision: "approve" } })).toBeUndefined();
    // allowOther takes the person's own words
    expect(
      checkAnswers([domainQuestion], { image_domain: "https://img.southernbrave.co.uk" }),
    ).toBeUndefined();
  });
});
