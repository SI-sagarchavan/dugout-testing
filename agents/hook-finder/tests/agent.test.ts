import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, scriptedModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { createMcpHost } from "@dugout/mcp";
import { fakeHub } from "@dugout/mcp/testing";
import { createHashEmbeddings, createMemoryStore } from "@dugout/memory";
import { afterAll, describe, expect, inject, it } from "vitest";
import { agent } from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const store = createMemoryStore({ pool, embeddings: createHashEmbeddings() });

/** Hooks as cast-mcp 0.5 lists them, text and structured. */
const HOOKS = [
  { id: "dugout_schedule", name: "dugout: Cricket Schedule", status: "published", nodeCount: 3 },
  {
    id: "fanxp-seed-hook-cricket-schedule",
    name: "Cricket Schedule",
    status: "published",
    nodeCount: 6,
  },
];
const listed = (args: Record<string, unknown>) => {
  const prefix = typeof args.idPrefix === "string" ? args.idPrefix : "";
  const hooks = HOOKS.filter((h) => h.id.startsWith(prefix));
  return {
    text: hooks.map((h) => `  ${h.id}  "${h.name}"  [${h.status}]`).join("\n"),
    structured: { total: HOOKS.length, hooks },
    isError: false,
  };
};
const DESCRIBED = {
  text: "HOOK  dugout_schedule\nINPUT\n  page_size  string  optional\nSTEPS\n  n1  apiCall\n      GET /schedule",
  structured: {
    id: "dugout_schedule",
    name: "dugout: Cricket Schedule",
    status: "published",
    workflowId: "7d0c1f9e-0000-4000-8000-000000000001",
    readOnly: true,
    callsHooks: false,
  },
  isError: false,
};
const ran = (status: "ok" | "error") => ({
  text: `RUN  r1  hook=dugout_schedule  status=${status}  10ms\n\nOUTPUT  (transform applied)\n  { data: { 1: Array<2> } }`,
  structured: {
    runId: "r1",
    hookId: "dugout_schedule",
    status,
    ...(status === "error"
      ? { error: { code: "input-validation", message: 'Input "page_size" must be a string' } }
      : {}),
    durationMs: 10,
    steps: [],
    outputComputed: true,
    output: status === "ok" ? { data: { "1": [{ state: "R" }, { state: "U" }] } } : undefined,
    budget: { remaining: 20, used: 5 },
  },
  isError: false,
});

/** The dev Cast server, stood in for: the real registry, grants and lock are used. */
const cast = (run: "ok" | "error" = "ok") =>
  fakeHub({
    cast_list_hooks: listed,
    cast_describe_hook: DESCRIBED,
    cast_run_hook: ran(run),
    cast_list_apis:
      '1 api(s) in sb:\n  fanxp-seed-api-cricket-schedule  "Cricket Schedule"\n      GET /schedule',
  });

const runWith = async (
  script: Parameters<typeof createScriptedModel>[0],
  run: "ok" | "error" = "ok",
) => {
  const hub = cast(run);
  const model = createScriptedModel(script);
  const start = agent.create({
    store,
    client: model,
    models: scriptedModelConfig(),
    runsDir: await mkdtemp(join(tmpdir(), "runs-")),
    consolidate: false,
    mcp: createMcpHost({ hub }),
  });
  const result = await start({
    tenantId: "demo-cricket",
    input: {
      need: "A strip of matches: each shows both teams' short names, crests and scores, and whether it is a result or upcoming.",
    },
    approver: async () => {
      throw new Error("the researcher never asks");
    },
  });
  return { result, model, hub };
};

const answer = (hookId: string | null, input: Record<string, string> = {}) => ({
  toolCalls: [
    {
      name: "final",
      arguments: {
        hookId,
        input,
        covers: ["match state → state (R, U)"],
        missing: [],
        why: "The only schedule hook of dugout's.",
      },
    },
  ],
});

describe("hook-finder", () => {
  it("gets its tools from the hooks.choose capability: dugout's hooks, read and run, nothing that writes", async () => {
    const { model } = await runWith([answer(null)]);
    const offered = model.requests[0]?.tools.map((t) => t.name).sort();
    expect(offered).toEqual([
      "cast.describeApi",
      "cast.describeHook",
      "cast.fetchSample",
      "cast.listApis",
      "cast.listHooks",
      "cast.runHook",
      "cast.validate",
      "final",
      "run.readOutput",
    ]);
    // Cast's own guidance comes with its tools, with what they are called here
    const system = String(model.requests[0]?.messages[0]?.content);
    expect(system).toContain("## Cast: what its MCP server says about its tools");
    expect(system).toContain("cast_list_hooks is cast.listHooks");
    // it is offered no reference document: Cast's output contract (a page envelope) is not its guide
    expect(system).not.toContain("- cast://contract/output");
    expect(system).not.toContain("cast.readResource");
    // the namespace is set by the harness: the model is not offered the filter
    const list = model.requests[0]?.tools.find((t) => t.name === "cast.listHooks");
    expect(JSON.stringify(list?.parameters)).not.toContain("idPrefix");
  });

  it("sees only dugout's hooks, and is refused another's before Cast is asked", async () => {
    const { model, hub } = await runWith([
      { toolCalls: [{ name: "cast.listHooks", arguments: {} }] },
      {
        toolCalls: [
          { name: "cast.describeHook", arguments: { hookId: "fanxp-seed-hook-cricket-schedule" } },
        ],
      },
      answer(null),
    ]);
    const shown = String(model.requests[1]?.messages.at(-1)?.content);
    expect(shown).toContain("dugout_schedule");
    expect(shown).not.toContain("fanxp-seed-hook-cricket-schedule");
    // Cast filters the list: the harness sends the namespace on every call
    expect(hub.calls[0]?.args).toEqual({ idPrefix: "dugout_" });
    expect(String(model.requests[2]?.messages.at(-1)?.content)).toContain(
      "cast.describeHook: outside what this agent may touch: hookId must match ^dugout_",
    );
    expect(hub.calls.map((c) => c.tool)).toEqual(["cast_list_hooks"]);
  });

  it("answers with a hook it ran with the transform, the input copied by the host", async () => {
    const { result, hub } = await runWith([
      { toolCalls: [{ name: "cast.describeHook", arguments: { hookId: "dugout_schedule" } }] },
      {
        toolCalls: [
          {
            name: "cast.runHook",
            arguments: {
              hookId: "dugout_schedule",
              applyTransform: true,
              input: { page_size: "2" },
            },
          },
        ],
      },
      // the model misremembers the input: the host keeps the one the run had
      answer("dugout_schedule", { page_size: "20" }),
    ]);
    expect(result).toMatchObject({
      status: "completed",
      output: { hookId: "dugout_schedule", input: { page_size: "2" } },
    });
    // running checks first that the hook only reads, then runs it, each under the run's tenant
    expect(hub.calls.map((c) => [c.tool, c.tenantId])).toEqual([
      ["cast_describe_hook", "demo-cricket"],
      ["cast_describe_hook", "demo-cricket"],
      ["cast_run_hook", "demo-cricket"],
    ]);
  });

  it("does not count a run that failed, though Cast answered it as a success", async () => {
    const { model } = await runWith(
      [
        {
          toolCalls: [
            {
              name: "cast.runHook",
              arguments: { hookId: "dugout_schedule", applyTransform: true, input: {} },
            },
          ],
        },
        answer("dugout_schedule"),
        answer(null),
      ],
      "error",
    );
    expect(String(model.requests[1]?.messages.at(-1)?.content)).toContain(
      'the run failed: input-validation: Input "page_size" must be a string',
    );
    expect(String(model.requests[2]?.messages.at(-1)?.content)).toContain(
      "dugout_schedule was not run in this run",
    );
  });

  it("refuses an answer that names a hook it never ran, and with no hook names the connectors", async () => {
    const { result, model } = await runWith([
      answer("dugout_schedule"),
      { toolCalls: [{ name: "cast.listApis", arguments: {} }] },
      {
        toolCalls: [
          {
            name: "final",
            arguments: {
              hookId: null,
              input: {},
              covers: [],
              missing: ["everything"],
              why: "None fits.",
              apis: ["fanxp-seed-api-cricket-schedule"],
            },
          },
        ],
      },
    ]);
    expect(String(model.requests[1]?.messages.at(-1)?.content)).toContain(
      "dugout_schedule was not run in this run",
    );
    expect(result).toMatchObject({
      status: "completed",
      output: { hookId: null, apis: ["fanxp-seed-api-cricket-schedule"] },
    });
  });
});
