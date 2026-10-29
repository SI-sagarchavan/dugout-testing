import type { Message, ToolInputDelta } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleClient } from "../src/index.ts";

const sse = (chunks: unknown[]) =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 0,
  model: "deepseek-v4-pro",
  system_fingerprint: "fp_1",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

function fakeFetch(responses: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}

const history: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "go" },
  {
    role: "assistant",
    content: "",
    reasoning: "think first",
    toolCalls: [{ id: "t1", name: "fixtures.get", arguments: '{"id":"f1"}' }],
  },
  { role: "tool", toolCallId: "t1", content: "{}" },
];

describe("openai-compatible client", () => {
  it("assembles a streamed turn: reasoning, content, split tool calls and trailing usage", async () => {
    const { fetch, bodies } = fakeFetch([
      sse([
        chunk({ role: "assistant", reasoning_content: "let me " }),
        chunk({ reasoning_content: "check" }),
        chunk({ content: "Saving" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "t2",
              type: "function",
              function: { name: "draft__save", arguments: '{"te' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] }),
        {
          ...chunk({}),
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            prompt_cache_hit_tokens: 60,
            prompt_cache_miss_tokens: 40,
            completion_tokens_details: { reasoning_tokens: 25 },
          },
        },
      ]),
    ]);
    const client = createOpenAICompatibleClient({
      baseURL: "https://llm.test",
      apiKey: "k",
      replayReasoning: true,
      fetch,
    });
    const tokens: string[] = [];
    const inputs: ToolInputDelta[] = [];

    const turn = await client.complete(
      {
        model: "deepseek-v4-pro",
        messages: history,
        tools: [{ name: "draft.save", description: "d", parameters: { type: "object" } }],
        reasoningEffort: "high",
        extraBody: { thinking: { type: "enabled" } },
      },
      (t) => tokens.push(t),
      (d) => inputs.push(d),
    );

    expect(turn.message).toEqual({
      role: "assistant",
      content: "Saving",
      reasoning: "let me check",
      toolCalls: [{ id: "t2", name: "draft.save", arguments: '{"text":"hi"}' }],
    });
    expect(tokens).toEqual(["Saving"]);
    // the arguments stream as they arrive, each fragment named by the call it belongs to
    expect(inputs).toEqual([
      { index: 0, callId: "t2", tool: "draft.save", text: '{"te' },
      { index: 0, callId: "t2", tool: "draft.save", text: 'xt":"hi"}' },
    ]);
    expect(turn.tokens).toEqual({
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 40,
      reasoningTokens: 25,
    });
    expect(turn.servedModel).toBe("deepseek-v4-pro (fp_1)");
    expect(turn.finishReason).toBe("tool_calls");

    const body = bodies[0] ?? {};
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      tools: [{ type: "function", function: { name: "draft__save" } }],
    });
    expect((body.messages as unknown[])[2]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "think first",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "fixtures__get", arguments: '{"id":"f1"}' },
        },
      ],
    });
    expect((body.messages as unknown[])[3]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "{}",
    });
  });

  it("does not replay reasoning when the provider does not want it", async () => {
    const { fetch, bodies } = fakeFetch([sse([chunk({ content: "ok" })])]);
    const client = createOpenAICompatibleClient({
      baseURL: "https://llm.test",
      apiKey: "k",
      replayReasoning: false,
      fetch,
    });
    await client.complete({ model: "m", messages: history, tools: [] });
    expect((bodies[0]?.messages as Record<string, unknown>[] | undefined)?.[2]).not.toHaveProperty(
      "reasoning_content",
    );
    expect(bodies[0]).not.toHaveProperty("tools");
  });

  it("retries a turn the provider aborted under load", async () => {
    const aborted = {
      ...chunk({}),
      choices: [{ index: 0, delta: {}, finish_reason: "insufficient_system_resource" }],
    };
    const { fetch, bodies } = fakeFetch([sse([aborted]), sse([chunk({ content: "ok" })])]);
    const client = createOpenAICompatibleClient({
      baseURL: "https://llm.test",
      apiKey: "k",
      replayReasoning: true,
      fetch,
      sleep: async () => {},
    });
    const turn = await client.complete({ model: "m", messages: history, tools: [] });
    expect(turn.message.content).toBe("ok");
    expect(bodies).toHaveLength(2);
  });

  it("gives up after maxRetries aborted turns", async () => {
    const aborted = () =>
      sse([{ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "aborted" }] }]);
    const { fetch } = fakeFetch([aborted(), aborted()]);
    const client = createOpenAICompatibleClient({
      baseURL: "https://llm.test",
      apiKey: "k",
      replayReasoning: true,
      maxRetries: 1,
      fetch,
      sleep: async () => {},
    });
    await expect(client.complete({ model: "m", messages: history, tools: [] })).rejects.toThrow(
      "ended with aborted after 2 attempts",
    );
  });
});
