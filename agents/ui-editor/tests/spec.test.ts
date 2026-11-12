import { describe, expect, it } from "vitest";
import { agent } from "../src/agent.ts";

describe("ui-editor's spec", () => {
  it("names each tool once, data-bind's child tool included (Bedrock refuses a tool named twice)", () => {
    const tools = agent.spec.tools;
    expect(tools).toContain("agent.dataBind");
    expect(new Set(tools).size).toBe(tools.length);
  });
});
