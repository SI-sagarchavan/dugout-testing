import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@dugout/contracts";
import { approve } from "@dugout/contracts";
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

const HOOK = "dugout_cricket_fixtures";
const OUTPUT = { data: { "1": [{ id: "1", venue: "Lord's" }] } };
/** A run as cast-mcp 0.5 answers it: text for the model, structured for the harness. */
const ran = (applied: boolean) => ({
  text: applied
    ? `RUN  r2  hook=${HOOK}  status=ok  30ms\n\nOUTPUT  (transform applied)\n  ${JSON.stringify(OUTPUT)}`
    : `RUN  r1  hook=${HOOK}  status=ok  30ms\n\nSTEPS (1)\n  n1  apiCall  ok`,
  structured: {
    runId: applied ? "r2" : "r1",
    hookId: HOOK,
    status: "ok",
    durationMs: 30,
    steps: [{ stepId: "n1", kind: "apiCall", status: "ok" }],
    outputComputed: applied,
    ...(applied ? { output: OUTPUT } : {}),
    budget: { remaining: 20, used: 5 },
  },
  isError: false,
});

/** Cast as a build meets it: the real registry, grants and lock, the server stood in for. */
const cast = () =>
  fakeHub({
    cast_describe_api:
      "fanxp-seed-api-cricket-schedule\n  GET /schedule\n  Used by fanxp-seed-hook-cricket-schedule (published).",
    cast_describe_hook: (args) => ({
      text: "HOOK x\nSTEPS\n  n1  apiCall\n      GET /schedule",
      structured: {
        id: args.hookId,
        name: "x",
        status: "draft",
        readOnly: true,
        callsHooks: false,
      },
      isError: false,
    }),
    cast_create_hook: (args) => `Created draft hook "${args.name}" (${args.id}).`,
    cast_add_step: (args) => `Added ${args.stepId ?? "n1"}.`,
    cast_run_hook: (args) => ran(args.applyTransform === true),
    cast_eval_jsonata: 'Evaluated cleanly. Result:\n\n{ "data": { "1": [] } }',
    cast_set_transform: "Saved.",
    cast_publish_hook: (args) => `Published "${args.hookId}".`,
  });

const ctx = (): ToolContext => ({
  tenantId: "demo-cricket",
  runId: "r",
  signal: new AbortController().signal,
});
/** A tool called as the loop calls it: schema, then the gate, then the run. */
const use = async (tool: Tool | undefined, args: unknown) => {
  if (!tool) throw new Error("no such tool");
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return { invalid: parsed.error.issues.map((i) => i.path.join(".")) };
  const refused = tool.block?.(parsed.data, ctx());
  if (refused) return { refused };
  return tool.run(parsed.data, ctx());
};

const create = async () => {
  const hub = cast();
  const model = createScriptedModel([]);
  const run = agent.create({
    store: createMemoryStore({ pool, embeddings: createHashEmbeddings() }),
    client: model,
    models: scriptedModelConfig(),
    runsDir: await mkdtemp(join(tmpdir(), "runs-")),
    consolidate: false,
    mcp: createMcpHost({ hub }),
  });
  return { run, hub, tool: (name: string) => run.tools.find((t) => t.name === name) };
};

describe("hook-maker's grants (hooks.author)", () => {
  it("writes only hooks in dugout's namespace, named so, and reads any", async () => {
    const { tool, hub } = await create();
    expect(
      await use(tool("cast.createHook"), { id: "cricket_fixtures", name: "dugout: x" }),
    ).toEqual({
      refused:
        "cast.createHook: outside what this agent may touch: id must match ^dugout_[a-z0-9_]+$",
    });
    expect(await use(tool("cast.createHook"), { id: HOOK, name: "Cricket fixtures" })).toEqual({
      refused: "cast.createHook: outside what this agent may touch: name must match ^dugout: ",
    });
    for (const [name, args] of [
      [
        "cast.addStep",
        { hookId: "fanxp-seed-hook-cricket-schedule", kind: "api_call", apiId: "a" },
      ],
      ["cast.setTransform", { hookId: "news_listing", mode: "whole", expression: "$" }],
      ["cast.publishHook", { hookId: "demo" }],
      ["cast.runHook", { hookId: "fixtures" }],
      ["cast.updateHook", { hookId: HOOK, name: "renamed" }],
    ] as const) {
      expect(await use(tool(name), args)).toMatchObject({
        refused: expect.stringContaining("outside what this agent may touch"),
      });
    }
    // what it may not do at all is not a tool it has
    for (const name of [
      "cast.deleteHook",
      "cast.setTemplateBinding",
      "cast.upsertApi",
      "cast.duplicateHook",
    ]) {
      expect(tool(name)).toBeUndefined();
    }
    // another hook is read, to copy the values it passes a connector
    expect(
      await use(tool("cast.describeHook"), { hookId: "fanxp-seed-hook-cricket-schedule" }),
    ).toContain("GET /schedule");
    expect(hub.calls.map((c) => c.tool)).toEqual(["cast_describe_hook"]);
    // its writes are writes: a person, or the call that started it, approves each
    expect(tool("cast.createHook")?.effect).toBe("write");
    expect(tool("cast.publishHook")?.effect).toBe("write");
  });
});

describe("hook-maker", () => {
  const steps = (finalAt: "early" | "end") => {
    const final = {
      toolCalls: [
        {
          name: "final",
          arguments: {
            hookId: HOOK,
            name: "dugout: Cricket fixtures",
            built: true,
            input: {},
            covers: ["venue → venue"],
            missing: [],
            why: "The schedule connector, items mapped to id and venue.",
          },
        },
      ],
    };
    const call = (name: string, args: Record<string, unknown>) => ({
      toolCalls: [{ name, arguments: args }],
    });
    return [
      call("cast.describeApi", { apiId: "fanxp-seed-api-cricket-schedule" }),
      call("cast.createHook", {
        id: HOOK,
        name: "dugout: Cricket fixtures",
        description: "Matches for the strip.",
      }),
      call("cast.addStep", {
        hookId: HOOK,
        kind: "api_call",
        apiId: "fanxp-seed-api-cricket-schedule",
        connectFrom: "input",
        connectTo: "output",
      }),
      call("cast.runHook", { hookId: HOOK }),
      call("cast.setTransform", { hookId: HOOK, mode: "whole", expression: "$" }),
      ...(finalAt === "early" ? [final] : []),
      call("cast.runHook", { hookId: HOOK, applyTransform: true, input: { page_size: "2" } }),
      call("cast.publishHook", { hookId: HOOK }),
      final,
    ];
  };

  it("builds, runs with its transform, publishes, and answers with the hook it built", async () => {
    const hub = cast();
    const model = createScriptedModel(steps("early"));
    const asked: string[] = [];
    const result = await agent.create({
      store: createMemoryStore({ pool, embeddings: createHashEmbeddings() }),
      client: model,
      models: scriptedModelConfig(),
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      mcp: createMcpHost({ hub }),
    })({
      tenantId: "demo-cricket",
      input: {
        need: { list: "matches", count: "data", item: [{ field: "venue", required: true }] },
      },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      output: { hookId: HOOK, input: { page_size: "2" } },
    });
    // run on its own, a person approves each write; as bind's child, bind's call approves them all
    expect(asked).toEqual([
      "cast.createHook",
      "cast.addStep",
      "cast.setTransform",
      "cast.publishHook",
    ]);
    // answering before it ran the transform it set is refused
    const refusal = model.requests.find((r) =>
      String(r.messages.at(-1)?.content).startsWith("Not accepted"),
    );
    expect(String(refusal?.messages.at(-1)?.content)).toContain(
      `Run ${HOOK} with applyTransform true after your last change to it`,
    );
    // the run checked the hook only reads before each run of it
    expect(hub.calls.filter((c) => c.tool === "cast_run_hook")).toHaveLength(2);
  });

  const finalFor = (hookId: string | null, built = false) => ({
    toolCalls: [
      {
        name: "final",
        arguments: {
          hookId,
          name: "dugout: Cricket fixtures",
          built,
          input: {},
          covers: ["venue → venue"],
          missing: [],
          why: built ? "Built it." : "It was already there.",
        },
      },
    ],
  });
  const call = (name: string, args: Record<string, unknown>) => ({
    toolCalls: [{ name, arguments: args }],
  });
  const asked: string[] = [];
  const runWith = async (script: Parameters<typeof createScriptedModel>[0]) => {
    const model = createScriptedModel(script);
    asked.length = 0;
    const result = await agent.create({
      store: createMemoryStore({ pool, embeddings: createHashEmbeddings() }),
      client: model,
      models: scriptedModelConfig(),
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      mcp: createMcpHost({ hub: cast() }),
    })({
      tenantId: "demo-cricket",
      input: {
        need: { list: "matches", count: "data", item: [{ field: "venue", required: true }] },
      },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
    });
    const refusals = model.requests
      .map((r) => String(r.messages.at(-1)?.content))
      .filter((m) => m.startsWith("Not accepted"));
    return { result, refusals, asked: [...asked] };
  };

  it("finds a hook that fits and answers with it: nothing created, changed or published, nobody asked", async () => {
    const { result, refusals, asked } = await runWith([
      call("cast.listHooks", {}),
      call("cast.describeHook", { hookId: HOOK }),
      call("cast.runHook", { hookId: HOOK, applyTransform: true, input: { page_size: "2" } }),
      finalFor(HOOK),
    ]);
    expect(refusals).toEqual([]);
    expect(asked).toEqual([]);
    expect(result).toMatchObject({
      status: "completed",
      output: { hookId: HOOK, built: false, input: { page_size: "2" } },
    });
  });

  it("will not answer with a hook it has not run with its transform", async () => {
    const { result, refusals } = await runWith([
      finalFor(HOOK),
      call("cast.runHook", { hookId: HOOK }),
      finalFor(HOOK),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      finalFor(HOOK),
    ]);
    expect(result.status).toBe("completed");
    // a run without the transform shows the raw API answers, which is not what a page reads
    expect(refusals).toEqual([
      expect.stringContaining(`${HOOK} was not run in this run. Run it with applyTransform true`),
      expect.stringContaining(`${HOOK} was not run in this run. Run it with applyTransform true`),
    ]);
  });

  it("will not answer with a hook it built that it has not run with its transform, or not published", async () => {
    const { result, refusals } = await runWith([
      call("cast.createHook", { id: HOOK, name: "dugout: Cricket fixtures" }),
      call("cast.setTransform", { hookId: HOOK, mode: "whole", expression: "$" }),
      finalFor(HOOK, true),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      finalFor(HOOK, true),
      call("cast.publishHook", { hookId: HOOK }),
      finalFor(HOOK, true),
    ]);
    expect(result.status).toBe("completed");
    expect(refusals).toEqual([
      expect.stringContaining(`Run ${HOOK} with applyTransform true after your last change`),
      expect.stringContaining(`Publish ${HOOK} before final`),
    ]);
  });

  it("says built the way it happened: not for a hook it found, and for one it changed", async () => {
    const { result, refusals } = await runWith([
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      finalFor(HOOK, true),
      call("cast.setTransform", { hookId: HOOK, mode: "whole", expression: "$" }),
      finalFor(HOOK, false),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      call("cast.publishHook", { hookId: HOOK }),
      finalFor(HOOK, true),
    ]);
    expect(result.status).toBe("completed");
    expect(refusals).toEqual([
      expect.stringContaining(`${HOOK} was found. Say built false`),
      expect.stringContaining(`You changed ${HOOK} in this run, so built is true`),
    ]);
  });

  it("answers with no hook when none fits and no connector could give it, but not after building one", async () => {
    const { result, refusals } = await runWith([
      call("cast.listHooks", {}),
      call("cast.createHook", { id: HOOK, name: "dugout: Cricket fixtures" }),
      finalFor(null),
      call("cast.setTransform", { hookId: HOOK, mode: "whole", expression: "$" }),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      call("cast.publishHook", { hookId: HOOK }),
      finalFor(HOOK, true),
    ]);
    expect(refusals).toEqual([
      expect.stringContaining("You created a hook in this run: answer with it"),
    ]);
    expect(result.status).toBe("completed");

    const none = await runWith([call("cast.listHooks", {}), finalFor(null)]);
    expect(none.refusals).toEqual([]);
    expect(none.result).toMatchObject({
      status: "completed",
      output: { hookId: null, built: false },
    });
  });

  it("will not answer with a hook it changed after running or publishing it", async () => {
    const { result, refusals } = await runWith([
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      call("cast.publishHook", { hookId: HOOK }),
      call("cast.setTransform", { hookId: HOOK, mode: "whole", expression: "$" }),
      finalFor(HOOK, true),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      finalFor(HOOK, true),
      call("cast.publishHook", { hookId: HOOK }),
      finalFor(HOOK, true),
    ]);
    expect(result.status).toBe("completed");
    expect(refusals).toEqual([
      expect.stringContaining(`Run ${HOOK} with applyTransform true after your last change`),
      expect.stringContaining(`You changed ${HOOK} after publishing it: publish it again`),
    ]);
  });

  it("will not build a second hook next to one it looked at without saying what that one lacks", async () => {
    const OTHER = "dugout_other_fixtures";
    const built = [
      call("cast.describeHook", { hookId: OTHER }),
      call("cast.createHook", { id: HOOK, name: "dugout: Cricket fixtures" }),
      call("cast.addStep", {
        hookId: HOOK,
        kind: "api_call",
        apiId: "fanxp-seed-api-cricket-schedule",
        connectFrom: "input",
        connectTo: "output",
      }),
      call("cast.setTransform", { hookId: HOOK, mode: "whole", expression: "$" }),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      call("cast.publishHook", { hookId: HOOK }),
    ];
    const withWhy = (existing?: string) => ({
      toolCalls: [
        {
          name: "final",
          arguments: {
            hookId: HOOK,
            name: "dugout: Cricket fixtures",
            built: true,
            input: {},
            covers: ["venue → venue"],
            missing: [],
            why: "A new one.",
            ...(existing ? { existing } : {}),
          },
        },
      ],
    });
    const { result, refusals } = await runWith([
      ...built,
      withWhy(),
      withWhy(`${OTHER} has no venue field`),
    ]);
    expect(result).toMatchObject({ status: "completed", output: { existing: expect.any(String) } });
    expect(refusals).toEqual([
      expect.stringContaining(`You built ${HOOK} though ${OTHER} was already there`),
    ]);
  });
});
