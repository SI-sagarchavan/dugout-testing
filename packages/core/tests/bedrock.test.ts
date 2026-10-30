import type { Message, ModelRequest, ToolInputDelta } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { createBedrockClient } from "../src/index.ts";

/** Stands in for the SDK client: records each command's input and streams the given events. */
function fakeRuntime(events: unknown[] | Error) {
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    async send(command: unknown) {
      inputs.push((command as { input: Record<string, unknown> }).input);
      if (events instanceof Error) throw events;
      return {
        stream: (async function* () {
          yield* events;
        })(),
      };
    },
  };
  return { runtime, inputs };
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "apac.amazon.nova-micro-v1:0",
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

describe("bedrock client", () => {
  it("streams a text turn and reports the requested model", async () => {
    const { runtime, inputs } = fakeRuntime([
      { messageStart: { role: "assistant" } },
      text(0, "Hel"),
      text(0, "lo"),
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: {} } },
    ]);
    const tokens: string[] = [];
    const turn = await createBedrockClient({ runtime }).complete(request(), (t) => tokens.push(t));

    expect(turn).toEqual({
      message: { role: "assistant", content: "Hello" },
      tokens: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 },
      servedModel: "apac.amazon.nova-micro-v1:0",
      finishReason: "end_turn",
    });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(inputs[0]).toEqual({
      modelId: "apac.amazon.nova-micro-v1:0",
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: [{ text: "go" }] }],
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

  it("assembles a tool call streamed in fragments, back under its dotted name", async () => {
    const { runtime } = fakeRuntime([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "hmm" } } } },
      text(0, "Saving"),
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t2", name: "draft__save" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"te' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'xt":"hi"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      {
        metadata: {
          usage: {
            inputTokens: 40,
            outputTokens: 25,
            totalTokens: 125,
            cacheReadInputTokens: 60,
          },
          metrics: {},
          trace: { promptRouter: { invokedModelId: "arn:aws:bedrock:nova-lite" } },
        },
      },
    ]);
    const tokens: string[] = [];
    const deltas: ToolInputDelta[] = [];
    const turn = await createBedrockClient({ runtime }).complete(
      request(),
      (t) => tokens.push(t),
      (d) => deltas.push(d),
    );

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
    // cache reads count as input, as in TokenUsage
    expect(turn.tokens).toEqual({
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 25,
      reasoningTokens: 0,
    });
    expect(turn.servedModel).toBe("arn:aws:bedrock:nova-lite");
    expect(turn.finishReason).toBe("tool_use");
  });

  it("reports zero usage when the stream has none, and {} for a tool with no input", async () => {
    const { runtime } = fakeRuntime([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t1", name: "run__readOutput" } },
        },
      },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    const turn = await createBedrockClient({ runtime }).complete(request());
    expect(turn.message.toolCalls).toEqual([{ id: "t1", name: "run.readOutput", arguments: "{}" }]);
    expect(turn.tokens).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("sends tool calls and results back as Converse blocks, in alternating turns", async () => {
    const { runtime, inputs } = fakeRuntime([{ messageStop: { stopReason: "end_turn" } }]);
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        reasoning: "never replayed",
        toolCalls: [
          { id: "t1", name: "fixtures.get", arguments: '{"id":"f1"}' },
          { id: "t2", name: "team.stats", arguments: "not json" },
        ],
      },
      { role: "tool", toolCallId: "t1", content: '{"home":"Lions"}' },
      { role: "tool", toolCallId: "t2", content: "" },
      { role: "user", content: "Change the title" },
    ];
    await createBedrockClient({ runtime }).complete(request({ messages }));

    expect(inputs[0]?.messages).toEqual([
      { role: "user", content: [{ text: "go" }] },
      {
        role: "assistant",
        content: [
          { toolUse: { toolUseId: "t1", name: "fixtures__get", input: { id: "f1" } } },
          { toolUse: { toolUseId: "t2", name: "team__stats", input: {} } },
        ],
      },
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "t1", content: [{ text: '{"home":"Lions"}' }] } },
          { toolResult: { toolUseId: "t2", content: [{ text: "(empty)" }] } },
          { text: "Change the title" },
        ],
      },
    ]);
  });

  it("turns a service error into an error named for its code", async () => {
    const denied = Object.assign(new Error("The provided model identifier is invalid."), {
      name: "ValidationException",
    });
    const { runtime } = fakeRuntime(denied);
    await expect(createBedrockClient({ runtime }).complete(request())).rejects.toThrow(
      "Bedrock ValidationException: The provided model identifier is invalid.",
    );
  });

  it("fails on an error event in the stream", async () => {
    const { runtime } = fakeRuntime([
      text(0, "Hel"),
      { throttlingException: { name: "ThrottlingException", message: "Too many requests" } },
    ]);
    await expect(createBedrockClient({ runtime }).complete(request())).rejects.toThrow(
      "Bedrock ThrottlingException: Too many requests",
    );
  });
});
