import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { castAdapter } from "../src/adapters/cast.ts";
import { hookOutput, NotSampled, type ServerCall, type ToolResult } from "../src/index.ts";

// What cast-mcp 0.5 answers, text and structured, for the Cricket Schedule hook: its description and
// a run with the transform applied. The data is dev Cast's (2026-11-04); the structured parts were
// checked against cast-mcp's own output schemas when written. The workflowId is made up.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as ToolResult & {
    structured: Record<string, unknown>;
  };
const DESCRIBED = fixture("describe-hook.json");
const RAN = fixture("run-hook.json");

const answer = (base: ToolResult, structured: Record<string, unknown>): ToolResult => ({
  ...base,
  structured: { ...(base.structured as object), ...structured },
});
const server = (answers: Record<string, ToolResult>) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call: ServerCall = async (tool, args) => {
    calls.push({ tool, args });
    const found = answers[tool];
    if (found === undefined) throw new Error(`unexpected ${tool}`);
    return found;
  };
  return { call, calls };
};

describe("the Cast adapter", () => {
  it("fetches a hook's whole output for code, from the run's structured answer", async () => {
    const ok = server({ cast_describe_hook: DESCRIBED, cast_run_hook: RAN });
    const { hook, output } = await hookOutput(ok.call, "dugout_x", { page_size: "3" });
    const data = output as { data: Record<string, unknown[]>; meta: unknown };
    expect(data.data["1"]).toHaveLength(3);
    expect(data.data["1"]?.[0]).toMatchObject({ match_id: "269416", event_state: "R" });
    expect(data.meta).toMatchObject({ pagination: { total: 17, per_page: 3 } });
    expect(hook.workflowId).toBe(DESCRIBED.structured.workflowId);
    // the output is whole in the structured answer: no character budget to raise
    expect(ok.calls[1]).toEqual({
      tool: "cast_run_hook",
      args: { hookId: "dugout_x", input: { page_size: "3" }, applyTransform: true },
    });
  });

  it("never runs a hook that writes or calls another hook", async () => {
    const guard = castAdapter.guards?.readOnlyHook;
    const writes = server({ cast_describe_hook: answer(DESCRIBED, { readOnly: false }) });
    expect(await guard?.({ hookId: "dugout_x" }, writes.call)).toMatch(
      /dugout_x is not run: a connector it calls is not a GET/,
    );
    await expect(hookOutput(writes.call, "dugout_x")).rejects.toThrow(NotSampled);
    expect(writes.calls.map((c) => c.tool)).toEqual(["cast_describe_hook", "cast_describe_hook"]);

    const nested = server({
      cast_describe_hook: answer(DESCRIBED, { readOnly: false, callsHooks: true }),
    });
    expect(await guard?.({ hookId: "dugout_x" }, nested.call)).toMatch(/calls another hook/);

    const reads = server({ cast_describe_hook: DESCRIBED });
    expect(await guard?.({ hookId: "dugout_x" }, reads.call)).toBeUndefined();
  });

  it("treats a run the server answered as a success, with status error, as failed", async () => {
    const failed = answer(RAN, {
      status: "error",
      error: { code: "input-validation", message: 'Input "page_size" must be a string' },
      output: undefined,
    });
    expect(castAdapter.failed?.("cast_run_hook", failed)).toBe(
      'the run failed: input-validation: Input "page_size" must be a string',
    );
    expect(castAdapter.failed?.("cast_run_hook", RAN)).toBeUndefined();
    expect(castAdapter.failed?.("cast_describe_hook", failed)).toBeUndefined();
    const ran = server({ cast_describe_hook: DESCRIBED, cast_run_hook: failed });
    await expect(hookOutput(ran.call, "dugout_x")).rejects.toThrow(/input-validation/);
  });

  it("refuses to read a server older than structured results", async () => {
    const old = server({
      cast_describe_hook: { text: DESCRIBED.text, isError: false },
      cast_run_hook: RAN,
    });
    await expect(hookOutput(old.call, "dugout_x")).rejects.toThrow(/older than cast-mcp 0.5/);
  });
});
