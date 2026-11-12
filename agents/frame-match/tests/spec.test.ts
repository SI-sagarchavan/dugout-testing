import { describe, expect, it } from "vitest";
import { spec } from "../src/agent.ts";

// House facts are about copy (previews, spelling, site menus). A run that loaded them spent its
// first message on rules that have nothing to do with matching a frame.
describe("frame-match memory", () => {
  it("reads its skill and nothing else", () => {
    expect(spec.memory.read).toEqual(["procedural"]);
    expect(spec.memory.write).toEqual([]);
  });

  it("reads how sections were built before (ADR 0034) and proposes and writes nothing", () => {
    expect(spec.tools.filter((tool) => tool.startsWith("memory."))).toEqual([
      "memory.read",
      "memory.search",
    ]);
  });
});
