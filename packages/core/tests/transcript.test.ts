import { answeredCalls, type Message } from "@dugout/contracts";
import { describe, expect, it } from "vitest";

const messages: Message[] = [
  { role: "system", content: "s" },
  { role: "user", content: "u" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "a", name: "cast.runHook", arguments: '{"hookId":"h1"}' },
      { id: "b", name: "ask", arguments: "not json" },
      { id: "c", name: "cast.runHook", arguments: '{"hookId":"h2"}' },
    ],
  },
  { role: "tool", toolCallId: "b", content: "answered" },
  { role: "tool", toolCallId: "a", content: "ran", isError: true },
  // `c` has no result: the run stopped before it was answered
];

describe("answeredCalls", () => {
  it("pairs each call with its result, in the order the results came", () => {
    expect(answeredCalls(messages)).toEqual([
      { at: 3, id: "b", name: "ask", args: undefined, content: "answered", isError: false },
      {
        at: 4,
        id: "a",
        name: "cast.runHook",
        args: { hookId: "h1" },
        content: "ran",
        isError: true,
      },
    ]);
  });

  it("keeps to the tool, or the tools, named", () => {
    expect(answeredCalls(messages, "ask").map((c) => c.id)).toEqual(["b"]);
    expect(answeredCalls(messages, ["ask", "cast.runHook"]).map((c) => c.id)).toEqual(["b", "a"]);
    expect(answeredCalls(messages, "frame.load")).toEqual([]);
  });
});
