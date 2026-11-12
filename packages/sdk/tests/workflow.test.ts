import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approve,
  defineTool,
  type Message,
  type ModelClient,
  type ModelRequest,
  type RunEvent,
} from "@dugout/contracts";
import {
  correctedInput,
  createMemoryRunStore,
  createMemorySink,
  scriptedModelConfig,
} from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import {
  type AnyAgent,
  CODE_TURN,
  defineAgent,
  defineStep,
  defineWorkflow,
  isTriesSpent,
  TriesSpent,
  WORKFLOW_TOOL,
  workflowDriver,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

type Turn = { final: unknown } | { ask: unknown } | { call: string; args: unknown };

/**
 * A model that answers each step from code: `answers[stepId]` gets the step's input (and how many
 * turns the step has had) and says what the model does. Steps are told apart by their
 * instructions, which start with `[stepId]`.
 */
function model(answers: Record<string, (input: never, turn: number, req: ModelRequest) => Turn>) {
  const calls: Array<{ step: string; input: unknown }> = [];
  const client: ModelClient = {
    async complete(req) {
      const system = String(req.messages[0]?.content);
      const step = Object.keys(answers).find((id) => system.startsWith(`[${id}]`));
      if (!step) throw new Error(`the model was called for no step: ${system.slice(0, 80)}`);
      const user = String(req.messages[1]?.content);
      const input = JSON.parse(user.slice(user.lastIndexOf("\n\n") + 2));
      const turn = req.messages.filter((m) => m.role === "assistant").length + 1;
      if (turn === 1) calls.push({ step, input });
      const said = (answers[step] as (i: unknown, t: number, r: ModelRequest) => Turn)(
        input,
        turn,
        req,
      );
      const call =
        "final" in said
          ? { name: "final", arguments: said.final }
          : "ask" in said
            ? { name: "ask", arguments: said.ask }
            : { name: said.call, arguments: said.args };
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `m_${req.messages.length}`,
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          ],
        },
        tokens: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
        },
        servedModel: req.model,
        finishReason: "tool_calls",
      };
    },
  };
  return { client, calls };
}

async function run(
  workflow: AnyAgent,
  client: ModelClient,
  input: unknown,
  opts: { responder?: Parameters<ReturnType<AnyAgent["create"]>>[0]["responder"] } = {},
) {
  const sink = createMemorySink();
  const start = workflow.create({
    store,
    client,
    models: scriptedModelConfig(),
    runsDir: await mkdtemp(join(tmpdir(), "workflow-")),
    consolidate: false,
  });
  const result = await start({
    tenantId: `wf-${randomUUID().slice(0, 6)}`,
    input: input as never,
    responder: opts.responder ?? (async () => approve("editor")),
    sinks: [sink],
    store: createMemoryRunStore(),
  });
  return { result, events: sink.events };
}

/** The workflow's own events: not the ones its steps' runs sent up. */
const own = (events: RunEvent[]) => events.filter((e) => !e.child);

const step = <I extends z.ZodType, O extends z.ZodType>(id: string, input: I, output: O) =>
  defineStep({ id, model: "nova-lite", instructions: `[${id}] Do it.`, input, output });

const Text = z.object({ text: z.string() });

describe("a workflow: code decides what runs next, a model is called inside a step", () => {
  it("chains steps, with a check in code between them (prompt chaining)", async () => {
    const draft = step("draft", z.object({ topic: z.string() }), Text);
    const improve = step("improve", Text, Text);
    const joke = defineWorkflow({
      id: "joke",
      description: "Writes a joke, and improves it when it has no punchline.",
      input: z.object({ topic: z.string() }),
      output: z.object({ text: z.string(), improved: z.boolean() }),
      steps: [draft, improve],
      async run(ctx, { topic }) {
        const first = await ctx.run(draft, { topic });
        // the gate is code: nothing a model has to decide
        if (first.text.includes("!")) return { text: first.text, improved: false };
        const better = await ctx.run(improve, first);
        return { text: better.text, improved: true };
      },
    });

    const flat = model({
      draft: ({ topic }: { topic: string }) => ({ final: { text: `a ${topic} joke` } }),
      improve: ({ text }: { text: string }) => ({ final: { text: `${text}!` } }),
    });
    const { result, events } = await run(joke, flat.client, { topic: "cat" });
    expect(result).toMatchObject({
      status: "completed",
      output: { text: "a cat joke!", improved: true },
    });
    expect(flat.calls).toEqual([
      { step: "draft", input: { topic: "cat" } },
      { step: "improve", input: { text: "a cat joke" } },
    ]);
    // the workflow's own two turns are code: they call no model and spend nothing
    const turns = own(events).filter((e) => e.type === "step.completed");
    expect(turns.map((e) => e.data.servedModel)).toEqual([CODE_TURN, CODE_TURN]);
    expect(turns.every((e) => e.data.usage.inputTokens === 0)).toBe(true);
    // each step is a run of its own, in this run's stream, and its spend is the workflow's
    expect(new Set(events.filter((e) => e.child).map((e) => e.child?.agentId))).toEqual(
      new Set(["draft", "improve"]),
    );
    expect((result as { usage: { inputTokens: number } }).usage.inputTokens).toBe(200);

    // the gate passes: the second step is never run
    const sharp = model({ draft: () => ({ final: { text: "ha!" } }) });
    const once = await run(joke, sharp.client, { topic: "cat" });
    expect(once.result).toMatchObject({ output: { text: "ha!", improved: false } });
    expect(sharp.calls.map((c) => c.step)).toEqual(["draft"]);
  });

  it("lets a step pick the branch (routing)", async () => {
    const route = step("route", Text, z.object({ kind: z.enum(["story", "poem"]) }));
    const story = step("story", Text, Text);
    const poem = step("poem", Text, Text);
    const writer = defineWorkflow({
      id: "writer",
      description: "Writes a story or a poem, whichever the request is for.",
      input: Text,
      output: Text,
      steps: [route, story, poem],
      async run(ctx, input) {
        const { kind } = await ctx.run(route, input);
        return ctx.run(kind === "story" ? story : poem, input);
      },
    });
    const m = model({
      route: ({ text }: { text: string }) => ({
        final: { kind: text.includes("rhyme") ? "poem" : "story" },
      }),
      story: () => ({ final: { text: "once upon a time" } }),
      poem: () => ({ final: { text: "roses are red" } }),
    });
    const { result } = await run(writer, m.client, { text: "make it rhyme" });
    expect(result).toMatchObject({ status: "completed", output: { text: "roses are red" } });
    expect(m.calls.map((c) => c.step)).toEqual(["route", "poem"]);
  });

  it("plans the work in one step and runs one for each part, some at once (orchestrator and workers)", async () => {
    const plan = step("plan", Text, z.object({ sections: z.array(z.string()) }));
    const write = step("write", z.object({ section: z.string() }), Text);
    let running = 0;
    let most = 0;
    const report = defineWorkflow({
      id: "report",
      description: "Plans a report's sections, writes each, and joins them.",
      input: Text,
      output: z.object({ report: z.string() }),
      steps: [plan, write],
      concurrency: 2,
      async run(ctx, input) {
        const { sections } = await ctx.run(plan, input);
        // one run for each section, each found again by its key
        const parts = await Promise.all(
          sections.map((section) => ctx.run(write, { section }, { key: section })),
        );
        // joining them is code
        return { report: parts.map((p) => p.text).join(" | ") };
      },
    });
    const m = model({
      plan: () => ({ final: { sections: ["intro", "body", "end"] } }),
      write: ({ section }: { section: string }) => {
        running++;
        most = Math.max(most, running);
        running--;
        return { final: { text: `about ${section}` } };
      },
    });
    const { result, events } = await run(report, m.client, { text: "cricket" });
    expect(result).toMatchObject({
      status: "completed",
      output: { report: "about intro | about body | about end" },
    });
    expect(m.calls.filter((c) => c.step === "write")).toHaveLength(3);
    // three runs of the one step, told apart by their keys
    const writers = new Set(
      events.filter((e) => e.child?.agentId === "write").map((e) => e.child?.runId),
    );
    expect(writers.size).toBe(3);
    expect(most).toBeLessThanOrEqual(2);
  });

  it("loops until a step that grades says it is good (evaluator and optimizer)", async () => {
    const write = step("write", z.object({ topic: z.string(), feedback: z.string() }), Text);
    const grade = step("grade", Text, z.object({ good: z.boolean(), feedback: z.string() }));
    const polished = defineWorkflow({
      id: "polished",
      description: "Writes, grades, and writes again with the feedback, three times at most.",
      input: z.object({ topic: z.string() }),
      output: z.object({ text: z.string(), passes: z.number() }),
      steps: [write, grade],
      async run(ctx, { topic }) {
        let feedback = "";
        let text = "";
        for (let pass = 1; pass <= 3; pass++) {
          // each pass is a call of its own: its key is the pass
          text = (await ctx.run(write, { topic, feedback }, { key: `${pass}` })).text;
          const verdict = await ctx.run(grade, { text }, { key: `${pass}` });
          if (verdict.good) return { text, passes: pass };
          feedback = verdict.feedback;
        }
        return { text, passes: 3 };
      },
    });
    const m = model({
      write: ({ feedback }: { feedback: string }) => ({
        final: { text: feedback ? "short and funny" : "long and dull" },
      }),
      grade: ({ text }: { text: string }) => ({
        final: { good: text.includes("funny"), feedback: "make it funny" },
      }),
    });
    const { result } = await run(polished, m.client, { topic: "cat" });
    expect(result).toMatchObject({
      status: "completed",
      output: { text: "short and funny", passes: 2 },
    });
    expect(m.calls.map((c) => c.step)).toEqual(["write", "grade", "write", "grade"]);
  });

  it("asks for a key when the same step is run twice, so a resumed run finds each result", async () => {
    const echo = step("echo", Text, Text);
    const twice = defineWorkflow({
      id: "twice",
      description: "Runs a step twice.",
      input: Text,
      output: Text,
      steps: [echo],
      async run(ctx, input) {
        await ctx.run(echo, input);
        return ctx.run(echo, input);
      },
    });
    const m = model({ echo: ({ text }: { text: string }) => ({ final: { text } }) });
    const { result } = await run(twice, m.client, { text: "hi" });
    expect(result).toMatchObject({ status: "failed", reason: "error" });
    expect((result as { message: string }).message).toContain(
      "twice runs echo twice: give each call its own key",
    );
  });

  it("fails with what the step said when a step fails, and lets code go another way", async () => {
    const strict = defineStep({
      id: "strict",
      model: "nova-lite",
      instructions: "[strict] Answer.",
      input: Text,
      output: Text,
      verify: (o) => (o.text === "right" ? undefined : "the answer must be right"),
    });
    const fallback = step("fallback", Text, Text);
    const wrong = model({
      strict: () => ({ final: { text: "wrong" } }),
      fallback: () => ({ final: { text: "plan b" } }),
    });

    const hard = defineWorkflow({
      id: "hard",
      description: "Runs a step that must be right.",
      input: Text,
      output: Text,
      steps: [strict],
      run: (ctx, input) => ctx.run(strict, input),
    });
    const failed = await run(hard, wrong.client, { text: "q" });
    expect(failed.result).toMatchObject({ status: "failed", reason: "error" });
    expect((failed.result as { message: string }).message).toMatch(/strict \(run .*\) failed/);
    // the step's own check sent the reason back to the model before it gave up
    expect(
      failed.events.filter((e) => e.type === "final.refused").map((e) => e.data.reason),
    ).toContain("the answer must be right");

    const soft = defineWorkflow({
      id: "soft",
      description: "Tries the strict step, and another when it fails.",
      input: Text,
      output: Text,
      steps: [strict, fallback],
      run: async (ctx, input) => {
        try {
          return await ctx.run(strict, input);
        } catch {
          return ctx.run(fallback, input);
        }
      },
    });
    const went = await run(soft, wrong.client, { text: "q" });
    expect(went.result).toMatchObject({ status: "completed", output: { text: "plan b" } });
  });

  it("refuses an answer of the wrong shape where the workflow returned it", async () => {
    const echo = step("echo", Text, Text);
    const loose = defineWorkflow({
      id: "loose",
      description: "Returns something else.",
      input: Text,
      output: z.object({ count: z.number() }),
      steps: [echo],
      run: async (ctx, input) => (await ctx.run(echo, input)) as never,
    });
    const m = model({ echo: ({ text }: { text: string }) => ({ final: { text } }) });
    const { result } = await run(loose, m.client, { text: "hi" });
    expect(result).toMatchObject({ status: "failed", reason: "error" });
    expect((result as { message: string }).message).toContain("count");
  });
});

describe("a workflow whose step writes", () => {
  const saved: string[] = [];
  const save = defineTool({
    name: "note.save",
    description: "Saves a note.",
    input: z.object({ text: z.string() }),
    effect: "write",
    timeoutMs: 1_000,
    run: async ({ text }) => {
      saved.push(text);
      return { saved: true };
    },
  });
  // an agent, not a step: it has a tool, and its model decides when to call it
  const keeper = defineAgent({
    spec: { id: "keeper", instructions: "[keeper] Save the note.", model: "nova-lite" },
    input: Text,
    output: z.object({ saved: z.boolean() }),
    tools: [save],
  });
  const keep = (approval?: "once" | "none") =>
    defineWorkflow({
      id: "keep",
      description: "Saves the note it is given.",
      input: Text,
      output: z.object({ saved: z.boolean() }),
      steps: [keeper],
      ...(approval ? { approval } : {}),
      run: (ctx, input) => ctx.run(keeper, input) as Promise<{ saved: boolean }>,
    });
  const m = () =>
    model({
      keeper: ({ text }: { text: string }, turn) =>
        turn === 1
          ? { call: "note.save", args: { text, reason: "the note asked for" } }
          : { final: { saved: true } },
    });

  it("is approved once, before it starts, and that yes covers the step's write", async () => {
    saved.length = 0;
    const { result, events } = await run(keep(), m().client, { text: "hello" });
    expect(result).toMatchObject({ status: "completed", output: { saved: true } });
    expect(saved).toEqual(["hello"]);
    // one question to a person, the workflow's own, with what it does as the reason; the step's
    // write is let through under that yes, by the call and not by a person
    const asked = own(events).filter((e) => e.type === "question.asked");
    expect(asked).toHaveLength(1);
    const let_ = events.flatMap((e) =>
      e.child && e.type === "question.answered" ? [e.data.source] : [],
    );
    expect(let_).toHaveLength(1);
    expect(let_[0]).not.toBe("person");
    expect(asked[0]?.data).toMatchObject({ tool: WORKFLOW_TOOL });
    expect(JSON.stringify(asked[0]?.data)).toContain("Saves the note it is given.");
  });

  it("ends rejected when the person says no, with nothing written", async () => {
    saved.length = 0;
    const { result } = await run(
      keep(),
      m().client,
      { text: "hello" },
      {
        responder: async () => ({
          by: "editor",
          answers: { review: { decision: "reject", comment: "not now" } },
        }),
      },
    );
    expect(result.status).toBe("rejected");
    expect(saved).toEqual([]);
  });

  it("starts without asking when it says so", async () => {
    saved.length = 0;
    const { result, events } = await run(keep("none"), m().client, { text: "hello" });
    expect(result).toMatchObject({ status: "completed" });
    expect(saved).toEqual(["hello"]);
    expect(own(events).filter((e) => e.type === "question.asked")).toEqual([]);
  });
});

describe("a step that asks a person", () => {
  it("pauses the workflow with the step's question, and carries on with the answer", async () => {
    const pick = step("pick", Text, Text);
    const asking = defineWorkflow({
      id: "asking",
      description: "Asks which colour, then says it.",
      input: Text,
      output: Text,
      steps: [pick],
      run: (ctx, input) => ctx.run(pick, input),
    });
    const m = model({
      pick: (_input: unknown, turn, req) => {
        if (turn === 1) {
          return {
            ask: {
              questions: [
                {
                  id: "colour",
                  kind: "choice",
                  question: "Which colour?",
                  why: "the design does not say",
                  options: [
                    { value: "red", label: "Red", description: "" },
                    { value: "blue", label: "Blue", description: "" },
                  ],
                  allowOther: false,
                  proposed: [],
                  remember: "no",
                  fact: "",
                },
              ],
            },
          };
        }
        // the answers come back as the result of its `ask`
        const answer = String(req.messages.findLast((m) => m.role === "tool")?.content);
        return { final: { text: answer.includes("blue") ? "blue" : "red" } };
      },
    });
    const { result, events } = await run(
      asking,
      m.client,
      { text: "paint it" },
      {
        responder: async (req) =>
          req.questions[0]?.id === "colour"
            ? { by: "sam", answers: { colour: "blue" } }
            : approve("editor"),
      },
    );
    expect(result).toMatchObject({ status: "completed", output: { text: "blue" } });
    // the question reached the run a host follows, from the step that asked it
    const asked = own(events).filter((e) => e.type === "question.asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.data.questions[0]).toMatchObject({ id: "colour" });
    expect(asked[0]?.data.from).toHaveLength(1);
  });
});

describe("a workflow's own turns, which code takes", () => {
  const driver = workflowDriver("report", "Writes the report.", WORKFLOW_TOOL);
  const tool = (required: string[] = []) => ({
    name: WORKFLOW_TOOL,
    description: "",
    parameters: { type: "object", properties: {}, required },
  });
  const req = (messages: Message[], required?: string[]): ModelRequest => ({
    model: "haiku",
    messages,
    tools: [tool(required)],
  });
  const start: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: '{"topic":"a"}' },
  ];
  const called = (id: string, name: string, content: string, isError = false): Message[] => [
    { role: "assistant", content: "", toolCalls: [{ id, name, arguments: "{}" }] },
    { role: "tool", toolCallId: id, content, ...(isError ? { isError: true } : {}) },
  ];

  it("starts the workflow, saying why when it is a write, then hands over the result", () => {
    expect(driver(req(start))).toEqual([{ name: WORKFLOW_TOOL }]);
    expect(driver(req(start, ["reason"]))).toEqual([
      { name: WORKFLOW_TOOL, arguments: { reason: "Writes the report." } },
    ]);
    expect(driver(req([...start, ...called("a", WORKFLOW_TOOL, "{}")]))).toEqual([
      { name: "final" },
    ]);
  });

  it("starts it again after a corrected input: a fork, or a follow-up in its thread", () => {
    const ended: Message[] = [
      ...start,
      ...called("a", WORKFLOW_TOOL, "{}"),
      { role: "assistant", content: "", toolCalls: [{ id: "f", name: "final", arguments: "{}" }] },
      { role: "user", content: correctedInput({ topic: "b" }) },
    ];
    expect(driver(req(ended))).toEqual([{ name: WORKFLOW_TOOL }]);
    expect(driver(req([...ended, ...called("b", WORKFLOW_TOOL, "{}")]))).toEqual([
      { name: "final" },
    ]);
  });

  it("ends the run with what was said when the workflow failed, or its result was refused", () => {
    const failed = [...start, ...called("a", WORKFLOW_TOOL, "Error: the step failed", true)];
    expect(() => driver(req(failed))).toThrow("the step failed");
    const refused = [
      ...start,
      ...called("a", WORKFLOW_TOOL, "{}"),
      ...called("f", "final", "Not accepted: report has not completed in this run.", true),
    ];
    expect(() => driver(req(refused))).toThrow("has not completed");
  });
});

describe("a step with no tries left", () => {
  it("says so by its type, which a workflow reads instead of the words", () => {
    expect(isTriesSpent(new TriesSpent("a person has to look"))).toBe(true);
    // another copy of the package's error, by name
    const other = Object.assign(new Error("x"), { name: "TriesSpent" });
    expect(isTriesSpent(other)).toBe(true);
    expect(isTriesSpent(new Error("it is not tried again: a person has to look."))).toBe(false);
  });
});
