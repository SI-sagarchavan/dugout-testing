import type { ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { type PipelineContext, pipelineTool } from "../src/index.ts";

/** A pipeline that only records what it was handed about its own pause. */
const recording = () => {
  const seen: PipelineContext[] = [];
  const tool = pipelineTool(
    {
      name: "page.build",
      description: "Records its context.",
      async run(_call, _input, own) {
        seen.push(own ?? {});
        return { ok: true };
      },
    },
    [],
  );
  const ctx = (answered?: ToolContext["answered"]) =>
    ({
      runId: `run-${seen.length}`,
      tenantId: "club-a",
      input: {},
      ...(answered ? { answered } : {}),
    }) as unknown as ToolContext;
  return { tool, seen, ctx };
};

describe("a pipeline's own pause", () => {
  it("hands the pipeline the answers to its own questions", async () => {
    const { tool, seen, ctx } = recording();
    await tool.run({}, ctx({ by: "sam", answers: { cast_budget: "first" } }));
    expect(seen[0]).toEqual({ answered: { by: "sam", answers: { cast_budget: "first" } } });
  });

  it("keeps a child's answers from it: they go to the child that asked", async () => {
    const { tool, seen, ctx } = recording();
    await tool.run({}, ctx({ by: "sam", answers: { loop: "no" }, from: ["child-run"] }));
    await tool.run({}, ctx());
    expect(seen).toEqual([{}, {}]);
  });
});
