import { describe, expect, it } from "vitest";
import { spec } from "../src/agent.ts";

// House facts are about copy (previews, spelling, site menus). A run that loaded them spent its
// first message on rules that have nothing to do with matching a frame.
describe("card-match memory", () => {
  it("reads its skill and nothing else", () => {
    expect(spec.memory.read).toEqual(["procedural"]);
    expect(spec.memory.write).toEqual([]);
  });

  it("has no memory tools, since there is nothing for them to read or write", () => {
    expect(spec.tools.filter((tool) => tool.startsWith("memory."))).toEqual([]);
  });
});
