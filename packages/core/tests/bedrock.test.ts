import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approve,
  defineTool,
  type Message,
  type ModelRequest,
  type ToolInputDelta,
} from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createBedrockClient,
  describeImage,
  optionalParameters,
  parseModelConfig,
  runLocal,
  strictSchema,
  TransientModelError,
  typedSchema,
} from "../src/index.ts";

const price = { input: 1, cacheRead: 0.1, output: 2 };
const models = parseModelConfig({
  models: {
    micro: {
      id: "apac.amazon.nova-micro-v1:0",
      contextWindow: 128_000,
      maxOutputTokens: 10_000,
      price,
    },
    "nova-2": {
      id: "global.amazon.nova-2-lite-v1:0",
      effort: "medium",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_535,
      price,
    },
    "nova-2-high": {
      id: "global.amazon.nova-2-lite-v1:0",
      effort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_535,
      price,
    },
    opus: {
      id: "global.anthropic.claude-opus-5-5",
      effort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      strictTools: true,
      price,
    },
    terra: {
      id: "global.openai.gpt-6.1-terra",
      effort: "low",
      contextWindow: 400_000,
      maxOutputTokens: 32_000,
      price,
    },
    "with-status": {
      id: "apac.amazon.nova-lite-v1:0",
      contextWindow: 300_000,
      maxOutputTokens: 10_000,
      toolErrorStatus: true,
      price,
    },
  },
});

/**
 * Stands in for the SDK client: records each command's input and streams the given events, the
 * same ones every call or one list per call.
 */
function fakeRuntime(events: unknown[] | unknown[][] | Error) {
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    async send(command: unknown) {
      inputs.push((command as { input: Record<string, unknown> }).input);
      if (events instanceof Error) throw events;
      const turn = Array.isArray(events[0]) ? (events[inputs.length - 1] as unknown[]) : events;
      return {
        stream: (async function* () {
          yield* turn;
        })(),
      };
    },
  };
  return { runtime, inputs, client: createBedrockClient({ runtime, models }) };
}

describe("describeImage", () => {
  it("sends a png to a claude model and returns its text", async () => {
    let sent = "";
    const runtime = {
      async send(command: unknown) {
        sent = JSON.stringify((command as { input: unknown }).input);
        return { output: { message: { content: [{ text: "white plate" }] } } };
      },
    };
    const text = await describeImage({
      png: Buffer.from([1, 2, 3]),
      prompt: "look",
      model: "opus",
      models,
      runtime,
    });
    expect(text).toBe("white plate");
    expect(sent).toContain("image");
    expect(sent).toContain("look");
  });

  it("refuses an image for a nova model", async () => {
    await expect(
      describeImage({
        png: Buffer.from([1]),
        prompt: "look",
        model: "micro",
        models,
        runtime: {
          async send() {
            return {};
          },
        },
      }),
    ).rejects.toThrow(/image/);
  });
});

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "micro",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
  ],
  tools: [
    {
      name: "draft.save",
      description: "Save a draft",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
  ...overrides,
});

const text = (index: number, value: string) => ({
  contentBlockDelta: { contentBlockIndex: index, delta: { text: value } },
});
const thought = (index: number, delta: Record<string, unknown>) => ({
  contentBlockDelta: { contentBlockIndex: index, delta: { reasoningContent: delta } },
});
const ended = (stopReason: string) => ({ messageStop: { stopReason } });

describe("bedrock client", () => {
  it("streams a text turn, sending the named model's id and output limit", async () => {
    const { client, inputs } = fakeRuntime([
      { messageStart: { role: "assistant" } },
      text(0, "Hel"),
      text(0, "lo"),
      { contentBlockStop: { contentBlockIndex: 0 } },
      ended("end_turn"),
      { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: {} } },
    ]);
    const tokens: string[] = [];
    const turn = await client.complete(request(), (t) => tokens.push(t));

    expect(turn).toEqual({
      message: { role: "assistant", content: "Hello" },
      tokens: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      },
      servedModel: "apac.amazon.nova-micro-v1:0",
      finishReason: "end_turn",
    });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(inputs[0]).toEqual({
      modelId: "apac.amazon.nova-micro-v1:0",
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: [{ text: "go" }] }],
      inferenceConfig: { maxTokens: 10_000 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "draft__save",
              description: "Save a draft",
              inputSchema: {
                json: { type: "object", properties: { text: { type: "string" } } },
              },
            },
          },
        ],
      },
    });
  });

  it("refuses a name the model list doesn't have", async () => {
    const { client } = fakeRuntime([]);
    await expect(client.complete(request({ model: "gpt" }))).rejects.toThrow(
      "no model named gpt; the list has micro, nova-2, nova-2-high, opus, terra, with-status",
    );
  });

  it("sends effort the way each family takes it", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    for (const model of ["opus", "nova-2", "nova-2-high", "micro", "terra"]) {
      await client.complete(request({ model }));
    }
    const sent = inputs.map(({ outputConfig, additionalModelRequestFields, inferenceConfig }) => ({
      outputConfig,
      additionalModelRequestFields,
      inferenceConfig,
    }));
    expect(sent).toEqual([
      { outputConfig: { effort: "high" }, inferenceConfig: { maxTokens: 128_000 } },
      {
        additionalModelRequestFields: {
          reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" },
        },
        inferenceConfig: { maxTokens: 65_535 },
      },
      // Nova 2 refuses maxTokens at high effort
      {
        additionalModelRequestFields: {
          reasoningConfig: { type: "enabled", maxReasoningEffort: "high" },
        },
        inferenceConfig: {},
      },
      { inferenceConfig: { maxTokens: 10_000 } },
      // Bedrock refuses `reasoning_effort` for OpenAI models; the nested form is the one it takes
      {
        additionalModelRequestFields: { reasoning: { effort: "low" } },
        inferenceConfig: { maxTokens: 32_000 },
      },
    ]);
  });

  it("assembles a tool call streamed in fragments, back under its dotted name", async () => {
    const { client } = fakeRuntime([
      { messageStart: { role: "assistant" } },
      thought(0, { text: "hmm" }),
      text(1, "Saving"),
      {
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: "t2", name: "draft__save" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"te' } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: 'xt":"hi"}' } } } },
      { contentBlockStop: { contentBlockIndex: 2 } },
      ended("tool_use"),
      {
        metadata: {
          usage: {
            inputTokens: 40,
            outputTokens: 25,
            totalTokens: 125,
            cacheReadInputTokens: 60,
            cacheWriteInputTokens: 20,
          },
          metrics: {},
          trace: { promptRouter: { invokedModelId: "arn:aws:bedrock:nova-lite" } },
        },
      },
    ]);
    const tokens: string[] = [];
    const deltas: ToolInputDelta[] = [];
    const turn = await client.complete(
      request(),
      (t) => tokens.push(t),
      (d) => deltas.push(d),
    );

    // reasoning with no signature is kept to read, but can't go back to the model
    expect(turn.message).toEqual({
      role: "assistant",
      content: "Saving",
      reasoning: "hmm",
      toolCalls: [{ id: "t2", name: "draft.save", arguments: '{"text":"hi"}' }],
    });
    // reasoning never reaches onToken
    expect(tokens).toEqual(["Saving"]);
    expect(deltas).toEqual([
      { index: 0, callId: "t2", tool: "draft.save", text: '{"te' },
      { index: 0, callId: "t2", tool: "draft.save", text: 'xt":"hi"}' },
    ]);
    // cache reads and writes count as input, as in TokenUsage
    expect(turn.tokens).toEqual({
      inputTokens: 120,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 20,
      outputTokens: 25,
      reasoningTokens: 0,
    });
    expect(turn.servedModel).toBe("arn:aws:bedrock:nova-lite");
    expect(turn.finishReason).toBe("tool_use");
  });

  it("keeps signed and encrypted reasoning blocks in order, to send back", async () => {
    const { client } = fakeRuntime([
      thought(0, { text: "Look up " }),
      thought(0, { text: "the fixture." }),
      thought(0, { signature: "sig-1" }),
      thought(1, { redactedContent: new Uint8Array([1, 2, 3]) }),
      text(2, "Done"),
      ended("end_turn"),
    ]);
    const turn = await client.complete(request({ model: "opus" }));
    expect(turn.message).toEqual({
      role: "assistant",
      content: "Done",
      reasoning: "Look up the fixture.",
      reasoningBlocks: [{ text: "Look up the fixture.", signature: "sig-1" }, { redacted: "AQID" }],
    });
  });

  it("reports zero usage when the stream has none, and {} for a tool with no input", async () => {
    const { client } = fakeRuntime([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t1", name: "run__readOutput" } },
        },
      },
      ended("tool_use"),
    ]);
    const turn = await client.complete(request());
    expect(turn.message.toolCalls).toEqual([{ id: "t1", name: "run.readOutput", arguments: "{}" }]);
    expect(turn.tokens).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });

  const toolTurns: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      reasoning: "Fetch both.",
      reasoningBlocks: [{ text: "Fetch both.", signature: "sig-1" }, { redacted: "AQID" }],
      toolCalls: [
        { id: "t1", name: "fixtures.get", arguments: '{"id":"f1"}' },
        { id: "t2", name: "team.stats", arguments: "not json" },
      ],
    },
    { role: "tool", toolCallId: "t1", content: '{"home":"Lions"}' },
    { role: "tool", toolCallId: "t2", content: "" },
    { role: "user", content: "Change the title" },
  ];
  const calls = [
    { toolUse: { toolUseId: "t1", name: "fixtures__get", input: { id: "f1" } } },
    { toolUse: { toolUseId: "t2", name: "team__stats", input: {} } },
  ];
  const results = {
    role: "user",
    content: [
      { toolResult: { toolUseId: "t1", content: [{ text: '{"home":"Lions"}' }] } },
      { toolResult: { toolUseId: "t2", content: [{ text: "(empty)" }] } },
      { text: "Change the title" },
    ],
  };

  it("sends tool calls and results back as Converse blocks, in alternating turns", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    await client.complete(request({ messages: toolTurns }));
    // Nova is never sent reasoning back
    expect(inputs[0]?.messages).toEqual([
      { role: "user", content: [{ text: "go" }] },
      { role: "assistant", content: calls },
      results,
    ]);
  });

  it("sends Claude its signed reasoning back first in the turn, unchanged", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    await client.complete(request({ model: "opus", messages: toolTurns, tools: [] }));
    expect(inputs[0]?.messages).toEqual([
      { role: "user", content: [{ text: "go" }] },
      {
        role: "assistant",
        content: [
          { reasoningContent: { reasoningText: { text: "Fetch both.", signature: "sig-1" } } },
          { reasoningContent: { redactedContent: Buffer.from([1, 2, 3]) } },
          ...calls,
        ],
      },
      results,
    ]);
  });

  it("puts cache points after the system prompt and at the end of the newest turn that takes one", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    const point = { cachePoint: { type: "default" } };
    await client.complete(request({ model: "opus", messages: toolTurns, cache: true }));
    await client.complete(request({ messages: toolTurns, cache: true }));
    await client.complete(request({ messages: toolTurns }));

    // Claude: any turn
    expect(inputs[0]?.system).toEqual([{ text: "sys" }, point]);
    expect((inputs[0]?.messages as unknown[] | undefined)?.at(-1)).toEqual({
      ...results,
      content: [...results.content, point],
    });
    // Nova: only a turn of text alone, here the first
    expect(inputs[1]?.system).toEqual([{ text: "sys" }, point]);
    expect(inputs[1]?.messages).toEqual([
      { role: "user", content: [{ text: "go" }, point] },
      { role: "assistant", content: calls },
      results,
    ]);
    // none unless asked
    expect(JSON.stringify(inputs[2])).not.toContain("cachePoint");
  });

  it("never sends a tool strict that says it is not, so a rich schema cannot overflow the grammar", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    const plain = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    await client.complete(
      request({
        model: "opus",
        tools: [
          { name: "a.one", description: "a", parameters: plain },
          { name: "ask", description: "ask", parameters: plain, strict: false },
        ],
      }),
    );
    type Sent = { toolConfig: { tools: Array<{ toolSpec: Record<string, unknown> }> } };
    const strict = (inputs[0] as Sent).toolConfig.tools.map((t) => t.toolSpec.strict === true);
    expect(strict).toEqual([true, false]);
  });

  it("sends its largest strict tools without strict while the grammar is too large, and remembers", async () => {
    // run 949eb0a1: data-bind's strict tools together compiled past Bedrock's grammar limit
    const tooLarge = Object.assign(
      new Error(
        "The model returned the following errors: The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
      ),
      { name: "ValidationException" },
    );
    const inputs: Array<Record<string, unknown>> = [];
    type Sent = { toolConfig: { tools: Array<{ toolSpec: Record<string, unknown> }> } };
    const strictOf = (input: unknown) =>
      (input as Sent).toolConfig.tools
        .filter((t) => t.toolSpec.strict === true)
        .map((t) => t.toolSpec.name);
    const runtime = {
      async send(command: unknown) {
        const input = (command as { input: Record<string, unknown> }).input;
        inputs.push(input);
        // the grammar fits once "big" and "mid" go without strict
        if (strictOf(input).some((name) => name === "big" || name === "mid")) throw tooLarge;
        return {
          stream: (async function* () {
            yield ended("end_turn");
          })(),
        };
      },
    };
    const client = createBedrockClient({ runtime, models });
    const props = (n: number) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
      required: Array.from({ length: n }, (_, i) => `p${i}`),
    });
    const tools = [
      { name: "small", description: "s", parameters: props(1) },
      { name: "big", description: "b", parameters: props(30) },
      { name: "mid", description: "m", parameters: props(10) },
    ];
    await client.complete(request({ model: "opus", tools }));
    expect(inputs.map(strictOf)).toEqual([["small", "big", "mid"], ["small", "mid"], ["small"]]);
    // the next turn with the same tools goes straight to what Bedrock took
    await client.complete(request({ model: "opus", tools }));
    expect(inputs).toHaveLength(4);
    expect(strictOf(inputs[3])).toEqual(["small"]);
  });

  it("keeps tools strict only while their optional parameters stay within Bedrock's limit", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    // ten optional parameters each: two fit in the 24 Bedrock takes, the third would not
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`p${i}`, { type: "string" }]),
        ),
      },
    });
    await client.complete(
      request({ model: "opus", tools: [tool("a.one"), tool("b.two"), tool("c.three")] }),
    );
    type Sent = { toolConfig: { tools: Array<{ toolSpec: Record<string, unknown> }> } };
    const strict = (inputs[0] as Sent).toolConfig.tools.map((t) => t.toolSpec.strict === true);
    expect(strict).toEqual([true, true, false]);
    expect(optionalParameters(tool("x.y").parameters)).toBe(10);
    expect(
      optionalParameters({
        type: "object",
        properties: { a: { type: "object", properties: { b: { type: "string" } } } },
        required: ["a"],
      }),
    ).toBe(1);
  });

  it("sends strict tools to a model that takes them, with every object closed", async () => {
    const { client, inputs } = fakeRuntime([ended("end_turn")]);
    const tools = [
      {
        name: "page.add",
        description: "Adds a page",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 60 },
            // a property named like a keyword is kept
            minLength: { type: "number", minimum: 0 },
            sections: {
              type: "array",
              minItems: 1,
              items: { type: "object", properties: { id: { type: "string" } } },
            },
          },
          required: ["title"],
        },
      },
      {
        name: "meta.set",
        description: "Sets any keys",
        parameters: {
          type: "object",
          properties: { values: { type: "object", additionalProperties: { type: "string" } } },
        },
      },
    ];
    await client.complete(request({ model: "opus", tools }));
    await client.complete(request({ tools }));

    type Sent = { toolConfig: { tools: Array<{ toolSpec: Record<string, unknown> }> } };
    const specs = (input?: Record<string, unknown>) =>
      (input as Sent).toolConfig.tools.map((t) => t.toolSpec);
    const [page, meta] = specs(inputs[0]);
    expect(page).toEqual({
      name: "page__add",
      description: "Adds a page",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            title: { type: "string" },
            minLength: { type: "number" },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
      strict: true,
    });
    // an open object (a record) can't be strict, so that tool goes without
    expect(meta).toEqual({
      name: "meta__set",
      description: "Sets any keys",
      inputSchema: { json: tools[1]?.parameters },
    });
    expect(specs(inputs[1]).some((t) => "strict" in t)).toBe(false);
    expect(strictSchema(tools[1]?.parameters as Record<string, unknown>)).toBeUndefined();
    // a page tree refers to itself; strict mode rejects that, so the tool goes without
    expect(
      strictSchema({
        type: "object",
        properties: { pages: { type: "array", items: { $ref: "#/$defs/__schema0" } } },
        $defs: {
          __schema0: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: { type: "array", items: { $ref: "#/$defs/__schema0" } },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("sends toolChoice for a forced tool, with the name encoded", async () => {
    const { client, inputs } = fakeRuntime([text(0, "x"), ended("end_turn")]);
    await client.complete(
      request({
        model: "opus",
        tools: [{ name: "final.x", description: "d", parameters: { type: "object" } }],
        toolChoice: { tool: "final.x" },
      }),
    );
    await client.complete(request());
    type Sent = { toolConfig: { toolChoice?: unknown } };
    expect((inputs[0] as Sent).toolConfig.toolChoice).toEqual({ tool: { name: "final__x" } });
    expect((inputs[1] as Sent).toolConfig.toolChoice).toBeUndefined();
  });

  it("sends status error on a failed tool result only for a model with toolErrorStatus", async () => {
    const { client, inputs } = fakeRuntime([text(0, "x"), ended("end_turn")]);
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "draft.save", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "t1", content: "Error: no", isError: true },
    ];
    await client.complete(request({ model: "with-status", messages }));
    await client.complete(request({ model: "micro", messages }));
    expect(JSON.stringify(inputs[0]?.messages)).toContain('"status":"error"');
    expect(JSON.stringify(inputs[1]?.messages)).not.toContain('"status"');
  });

  it("turns a service error into an error named for its code", async () => {
    const denied = Object.assign(new Error("The provided model identifier is invalid."), {
      name: "ValidationException",
    });
    const { client } = fakeRuntime(denied);
    await expect(client.complete(request())).rejects.toThrow(
      "Bedrock ValidationException: The provided model identifier is invalid.",
    );
  });

  it("maps a throttle to a transient error that keeps its cause, and a validation error not", async () => {
    const throttled = Object.assign(new Error("Too many requests"), {
      name: "ThrottlingException",
    });
    const first = await fakeRuntime(throttled)
      .client.complete(request())
      .catch((e) => e);
    expect(first).toBeInstanceOf(TransientModelError);
    expect(first.cause).toBe(throttled);
    const invalid = Object.assign(new Error("bad"), { name: "ValidationException" });
    const second = await fakeRuntime(invalid)
      .client.complete(request())
      .catch((e) => e);
    expect(second).toBeInstanceOf(Error);
    expect(second).not.toBeInstanceOf(TransientModelError);
  });

  it.each([
    "throttlingException",
    "serviceUnavailableException",
    "internalServerException",
    "modelStreamErrorException",
  ])("treats %s in the stream as transient, named or not", async (key) => {
    const { client } = fakeRuntime([text(0, "Hel"), { [key]: { message: "later" } }]);
    const err = await client.complete(request()).catch((e) => e);
    expect(err).toBeInstanceOf(TransientModelError);
    expect(err.message).toMatch(/^Bedrock \w+Exception: later$/);
  });

  it.each([
    [
      "a dropped DNS lookup, named only in the message",
      new Error(
        "The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.ap-south-1.amazonaws.com)",
      ),
    ],
    [
      "a reset connection, as a code on the cause",
      new Error("socket hang up", {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
    ],
    [
      "a request that timed out in the SDK",
      Object.assign(new Error("Connection timed out after 3000 ms"), { name: "TimeoutError" }),
    ],
  ])("treats %s as transient", async (_, failure) => {
    const err = await fakeRuntime(failure)
      .client.complete(request())
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransientModelError);
    expect(err.cause).toBe(failure);
  });

  it("does not treat a validation error in the stream as transient", async () => {
    const { client } = fakeRuntime([{ validationException: { message: "bad" } }]);
    const err = await client.complete(request()).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientModelError);
    expect(err.message).toBe("Bedrock ValidationException: bad");
  });

  it("fails on an error event in the stream", async () => {
    const { client } = fakeRuntime([
      text(0, "Hel"),
      { throttlingException: { name: "ThrottlingException", message: "Too many requests" } },
    ]);
    await expect(client.complete(request())).rejects.toThrow(
      "Bedrock ThrottlingException: Too many requests",
    );
  });
});

describe("a run on Claude", () => {
  it("replays signed reasoning across a tool call, unchanged and with the transcript append-only", async () => {
    const call = (id: string, name: string, input: string, index: number) => [
      {
        contentBlockStart: {
          contentBlockIndex: index,
          start: { toolUse: { toolUseId: id, name } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input } } } },
    ];
    const { runtime, inputs } = fakeRuntime([
      [
        thought(0, { text: "Need the fixture first." }),
        thought(0, { signature: "sig-1" }),
        ...call("t1", "fixture__get", '{"id":"f-1"}', 1),
        ended("tool_use"),
      ],
      [
        thought(0, { text: "Now the headline." }),
        thought(0, { signature: "sig-2" }),
        ...call("t2", "final", '{"headline":"Lions host Tigers"}', 1),
        ended("tool_use"),
      ],
    ]);
    const fixtureGet = defineTool({
      name: "fixture.get",
      description: "Look up a fixture.",
      input: z.object({ id: z.string() }),
      effect: "read",
      timeoutMs: 1_000,
      run: async () => ({ home: "Lions", away: "Tigers" }),
    });
    const result = await runLocal({
      agent: {
        spec: {
          id: "headline",
          version: 1,
          owner: "test",
          instructions: "Look up the fixture, then call final with a headline.",
          tools: ["fixture.get"],
          skills: [],
          onDemandSkills: [],
          model: "opus",
          memory: { read: [], write: [] },
          budget: { usdPerRun: 1, maxSteps: 4, maxDepth: 0 },
          approvals: [],
        },
        output: z.object({ headline: z.string() }),
      },
      input: "f-1",
      tenantId: "t",
      tools: [fixtureGet],
      client: createBedrockClient({ runtime, models }),
      models,
      responder: async () => approve("test"),
      runsDir: await mkdtemp(join(tmpdir(), "bedrock-run-")),
    });

    expect(result).toMatchObject({
      status: "completed",
      output: { headline: "Lions host Tigers" },
    });
    const [first, second] = inputs as Array<{ messages: Array<{ content: unknown[] }> }>;
    // the second request starts with the first one's messages, unchanged
    expect(second?.messages.slice(0, 1)).toEqual(
      first?.messages.map((m) => ({ ...m, content: m.content.filter((b) => !isCachePoint(b)) })),
    );
    expect(second?.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          reasoningContent: {
            reasoningText: { text: "Need the fixture first.", signature: "sig-1" },
          },
        },
        { toolUse: { toolUseId: "t1", name: "fixture__get", input: { id: "f-1" } } },
      ],
    });
    // a run asks for the cache; only the newest turn carries the moving cache point
    expect(second?.messages[2]?.content.at(-1)).toEqual({ cachePoint: { type: "default" } });
  });
});

const isCachePoint = (block: unknown) =>
  typeof block === "object" && block !== null && "cachePoint" in block;

describe("tool schemas Bedrock takes", () => {
  it("gives a type to a sub-schema that accepts anything, and leaves a shaped one alone", () => {
    // cast_eval_jsonata's `input`, and cast_run_hook's free-form `input` record, as Cast declares them
    const declared = {
      type: "object",
      properties: {
        expression: { type: "string" },
        input: { description: "The value to evaluate against." },
        record: { type: "object", additionalProperties: {} },
        either: { anyOf: [{ type: "string" }, {}] },
        level: { enum: ["a", "b"] },
      },
      required: ["expression"],
    };
    const any = ["string", "number", "integer", "boolean", "object", "array", "null"];
    expect(typedSchema(declared)).toEqual({
      type: "object",
      properties: {
        expression: { type: "string" },
        input: { description: "The value to evaluate against.", type: any },
        record: { type: "object", additionalProperties: { type: any } },
        either: { anyOf: [{ type: "string" }, { type: any }] },
        level: { enum: ["a", "b"] },
      },
      required: ["expression"],
    });
    // a free-form value is an open object strict mode cannot take: that tool goes without strict
    expect(strictSchema(typedSchema(declared))).toBeUndefined();
    expect(
      strictSchema(typedSchema({ type: "object", properties: { a: { type: "string" } } })),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
  });
});
