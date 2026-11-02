import { join } from "node:path";
import { defineHook } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../src/index.ts";

describe("defineAgent hooks", () => {
  const hook = defineHook({ id: "mine", beforeModel: () => undefined });
  const make = (hooks?: Parameters<typeof defineAgent>[0]["hooks"]) =>
    defineAgent({
      spec: {
        id: "hooked",
        version: 1,
        owner: "test",
        instructions: "x",
        tools: [],
        skills: [],
        onDemandSkills: [],
        model: "nova-lite",
        memory: { read: [], write: [] },
        budget: { usdPerRun: 0.1, maxSteps: 3, maxDepth: 0 },
        approvals: [],
      },
      input: z.object({}),
      dir: join(import.meta.dirname, ".."),
      tools: () => [],
      ...(hooks ? { hooks } : {}),
    });

  it("hands an agent's hooks to the definition the loop runs", () => {
    expect(make([hook]).definition.hooks).toEqual([hook]);
  });

  it("has none unless the agent gives some", () => {
    expect(make().definition.hooks).toBeUndefined();
  });
});
