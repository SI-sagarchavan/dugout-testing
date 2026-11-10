import { AwaitingAnswers, type ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
    expect(seen[0]).toEqual({
      answered: { by: "sam", answers: { cast_budget: "first" } },
      args: {},
    });
  });

  it("keeps a child's answers from it: they go to the child that asked", async () => {
    const { tool, seen, ctx } = recording();
    await tool.run({}, ctx({ by: "sam", answers: { loop: "no" }, from: ["child-run"] }));
    await tool.run({}, ctx());
    expect(seen).toEqual([{ args: {} }, { args: {} }]);
  });
});

describe("a pipeline reports what is open and takes the decision as input (ticket 11)", () => {
  const ctx = (runId: string) => ({ runId, tenantId: "club-a", input: {}, callId: "c" }) as never;
  const pipeline = () => {
    const seen: unknown[] = [];
    const tool = pipelineTool(
      {
        name: "page.build",
        description: "Reports an open item until told what to bind.",
        input: z.object({ bind: z.array(z.string()).optional() }),
        async run(_call, _input, own) {
          seen.push(own?.args);
          const bind = (own?.args as { bind?: string[] } | undefined)?.bind;
          return bind
            ? { previewUrl: "p", bound: bind }
            : {
                open: [{ id: "cast_budget", about: "x", evidence: "y", canTake: "bind" }],
                note: "decide",
              };
        },
      },
      [],
    );
    return { tool, seen };
  };

  it("takes its arguments from the model, and hands them to the pipeline", async () => {
    const { tool, seen } = pipeline();
    expect(tool.input.safeParse({ bind: ["a"] }).success).toBe(true);
    expect(tool.input.safeParse({ nope: 1 }).success).toBe(false);
    await tool.run({ bind: ["a"] }, ctx("r1"));
    expect(seen).toEqual([{ bind: ["a"] }]);
  });

  it("is not done when it answered with what is open: calling it again runs it again", async () => {
    const { tool } = pipeline();
    const first = (await tool.run({}, ctx("r2"))) as { open?: unknown[] };
    expect(first.open).toHaveLength(1);
    expect(tool.block?.({}, ctx("r2"))).toBeUndefined();
    const second = await tool.run({ bind: ["a"] }, ctx("r2"));
    expect(second).toMatchObject({ previewUrl: "p" });
    // a completed answer is final: the same run may not build twice
    expect(tool.block?.({}, ctx("r2"))).toContain("already completed");
  });
});

describe("a question reaches the person at once (ticket 11)", () => {
  it("does not start a call that is waiting its turn once another has stopped the run to ask", async () => {
    const started: string[] = [];
    const child = { spec: { id: "binder" } } as never;
    const caller = {
      child,
      writes: true,
      completedFor: () => undefined,
      completedForInput: () => undefined,
      failuresFor: () => [],
      keysFor: () => [],
      async call(_input: unknown, _ctx: unknown, opts?: { key?: string }) {
        started.push(opts?.key ?? "");
        if (opts?.key === "squad") throw new AwaitingAnswers([], ["child-run"]);
        return { runId: "r", output: { done: opts?.key } };
      },
    };
    const tool = pipelineTool(
      {
        name: "page.build",
        description: "Binds two slots, one at a time.",
        concurrency: 1,
        async run(call) {
          // the squad asks; the fixtures slot is queued behind it
          const settled = await Promise.allSettled([
            call(child, {}, { key: "squad" }),
            call(child, {}, { key: "fixtures" }),
          ]);
          const first = settled[0];
          if (first?.status === "rejected") throw first.reason;
          return settled;
        },
      },
      [caller as never],
    );
    await expect(
      tool.run({}, { runId: "run-q", tenantId: "club-a", input: {}, callId: "c" } as never),
    ).rejects.toBeInstanceOf(AwaitingAnswers);
    // the fixtures slot never ran: its answers would have come before the question
    expect(started).toEqual(["squad"]);
  });
});
