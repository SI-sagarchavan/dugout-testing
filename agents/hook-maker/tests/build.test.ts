import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
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
const cast = (extra: Parameters<typeof fakeHub>[0] = {}) =>
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
    cast_list_providers: "No providers.",
    cast_list_apis: "No connectors.",
    cast_upsert_provider: (args) => `Created provider "${args.name}" (prov_1).`,
    cast_upsert_api: (args) => `Created api "${args.name}" (api_1): GET ${args.url}`,
    cast_fetch_sample: "200 OK\n  { squad: [ { name: 'Sophie' } ] }",
    cast_create_hook: (args) => `Created draft hook "${args.name}" (${args.id}).`,
    cast_add_step: (args) => `Added ${args.stepId ?? "n1"}.`,
    cast_run_hook: (args) => ran(args.applyTransform === true),
    cast_eval_jsonata: 'Evaluated cleanly. Result:\n\n{ "data": { "1": [] } }',
    cast_set_transform: "Saved.",
    cast_publish_hook: (args) => `Published "${args.hookId}".`,
    ...extra,
  });

const ctx = (): ToolContext => ({
  tenantId: "demo-cricket",
  runId: "r",
  signal: new AbortController().signal,
  state: memoryRunState(),
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
      "cast.deleteApi",
      "cast.setTemplateBinding",
      "cast.duplicateHook",
    ]) {
      expect(tool(name)).toBeUndefined();
    }
    // a connector or provider is created in dugout's namespace and never changed: it is shared
    for (const name of ["cast.upsertApi", "cast.upsertProvider"]) {
      expect(await use(tool(name), { id: "api_1", name: "dugout: squad" })).toMatchObject({
        refused: expect.stringContaining("must be left out"),
      });
      expect(await use(tool(name), { name: "squad feed" })).toMatchObject({
        refused: expect.stringContaining("name must match ^dugout: "),
      });
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
            covers: ["venue → data.1[].venue"],
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
      call("hook.evidence", { hookId: HOOK, covers: ["venue → data.1[].venue"] }),
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
        need: {
          list: "matches",
          count: "data",
          item: [{ field: "venue", required: true }],
        },
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
          covers: ["venue → data.1[].venue"],
          missing: [],
          why: built ? "Built it." : "It was already there.",
        },
      },
    ],
  });
  const call = (name: string, args: Record<string, unknown>) => ({
    toolCalls: [{ name, arguments: args }],
  });
  const read = (hookId = HOOK) =>
    call("hook.evidence", { hookId, covers: ["venue → data.1[].venue"] });
  const asked: string[] = [];
  const runWith = async (
    script: Parameters<typeof createScriptedModel>[0],
    needExtra: Record<string, unknown> = {},
  ) => {
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
        need: {
          list: "matches",
          count: "data",
          item: [{ field: "venue", required: true }],
          ...needExtra,
        },
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

  it("builds on the feeds a person gave: one provider, one connector for both feeds, then the hook", async () => {
    const SQUAD = "https://www.southernbrave.com/cricket/v2/series/squad";
    const WOMEN = `${SQUAD}?team_id=2034&series_id=15399&lang=en&feed_format=json&client_id=4ab1ce0f`;
    const MEN = `${SQUAD}?team_id=2042&series_id=15397&lang=en&feed_format=json&client_id=4ab1ce0f`;
    const hub = cast();
    const model = createScriptedModel([
      call("cast.listProviders", {}),
      call("cast.listApis", {}),
      call("cast.upsertProvider", {
        name: "dugout: www.southernbrave.com",
        baseUrl: "https://www.southernbrave.com/cricket/v2",
        authMode: "none",
      }),
      call("cast.upsertApi", {
        providerId: "prov_1",
        name: "dugout: Southern Brave squad",
        method: "GET",
        url: "{{env.base_url}}/series/squad",
        queryParams: [
          { key: "team_id", value: "{{input.team_id}}" },
          { key: "series_id", value: "{{input.series_id}}" },
          { key: "client_id", value: "4ab1ce0f" },
        ],
      }),
      call("cast.fetchSample", { apiId: "api_1", input: { team_id: "2034", series_id: "15399" } }),
      call("cast.createHook", { id: "dugout_brave_squad", name: "dugout: Brave squad" }),
      call("cast.runHook", { hookId: "dugout_brave_squad" }),
      call("cast.setTransform", { hookId: "dugout_brave_squad", mode: "whole", expression: "$" }),
      call("cast.runHook", { hookId: "dugout_brave_squad", applyTransform: true }),
      call("cast.publishHook", { hookId: "dugout_brave_squad" }),
      read("dugout_brave_squad"),
      {
        toolCalls: [
          {
            name: "final",
            arguments: {
              hookId: "dugout_brave_squad",
              name: "dugout: Brave squad",
              built: true,
              input: {},
              covers: ["venue → data.1[].venue"],
              missing: [],
              why: "One connector for both feeds; the output has women and men side by side, so each tab shows its list.",
              // the model's word: code lists what the run's own writes made instead
              created: ["provider prov_9 (dugout: something else)"],
            },
          },
        ],
      },
    ]);
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
        need: {
          list: "players",
          count: "data",
          item: [{ field: "venue", required: true }],
          sources: [
            { label: "women", url: WOMEN },
            { label: "men", url: MEN },
          ],
        },
      },
      responder: async (req) => {
        asked.push(req.tool);
        return approve("editor");
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      output: { hookId: "dugout_brave_squad", built: true, basis: "sources" },
    });
    // built by code from the completed writes and the ids their results gave (ticket 12)
    expect((result as { output: { created: string[] } }).output.created).toEqual([
      "provider prov_1 (dugout: www.southernbrave.com)",
      "connector api_1 (dugout: Southern Brave squad)",
      "hook dugout_brave_squad (dugout: Brave squad)",
    ]);
    // a provider and one connector made, each approved; nothing existing was changed
    expect(asked.slice(0, 2)).toEqual(["cast.upsertProvider", "cast.upsertApi"]);
    const made = hub.calls.filter((c) => c.tool.startsWith("cast_upsert"));
    expect(made).toHaveLength(2);
    for (const c of made) {
      expect(c.args.id).toBeUndefined();
      expect(String(c.args.name)).toMatch(/^dugout: /);
    }
    // the sources reached the model in the call's input
    const first = JSON.stringify(model.requests[0]?.messages);
    expect(first).toContain("team_id=2034");
    expect(first).toContain("team_id=2042");
  });

  it("is told, in its instructions and skill, what to do with the feeds a person gave", async () => {
    const { run } = await create();
    expect(run.spec.instructions).toMatch(/need has sources/);
    expect(run.spec.instructions).toMatch(
      /not GET, or answers an error or not JSON, goes in missing/,
    );
    const { readFileSync } = await import("node:fs");
    const skill = readFileSync(join(import.meta.dirname, "../skills/hook-maker.md"), "utf8");
    expect(skill).toMatch(/## When a person gave the feed[\s\S]*## When none fits/);
    for (const step of [
      "cast.listProviders",
      "cast.upsertProvider",
      "cast.upsertApi",
      "cast.fetchSample",
    ])
      expect(skill).toContain(step);
  });

  it("finds a hook that fits and answers with it: nothing created, changed or published, nobody asked", async () => {
    const { result, refusals, asked } = await runWith([
      call("cast.listHooks", {}),
      call("cast.describeHook", { hookId: HOOK }),
      call("cast.runHook", { hookId: HOOK, applyTransform: true, input: { page_size: "2" } }),
      read(),
      finalFor(HOOK),
    ]);
    expect(refusals).toEqual([]);
    expect(asked).toEqual([]);
    expect(result).toMatchObject({
      status: "completed",
      output: { hookId: HOOK, built: false, input: { page_size: "2" } },
    });
  });

  it("will not say it covers a path the run's real output has nothing at", async () => {
    const wrong = {
      toolCalls: [
        {
          name: "final",
          arguments: {
            hookId: HOOK,
            name: "dugout: Cricket fixtures",
            built: false,
            input: {},
            covers: ["venue → matches[].venue"],
            missing: [],
            why: "It was already there.",
          },
        },
      ],
    };
    const { result, refusals } = await runWith([
      call("cast.describeHook", { hookId: HOOK }),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      read(),
      wrong,
      finalFor(HOOK),
    ]);
    // the path is from the root of the output the run gave (data.1[].venue), not the model's guess
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("does not give what you say");
    expect(refusals[0]).toContain('covers "venue" at matches[].venue');
    expect(result).toMatchObject({ status: "completed" });
  });

  it("will not answer with a hook it has not run with its transform", async () => {
    const { result, refusals } = await runWith([
      finalFor(HOOK),
      call("cast.runHook", { hookId: HOOK }),
      finalFor(HOOK),
      call("cast.runHook", { hookId: HOOK, applyTransform: true }),
      read(),
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
      read(),
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
      read(),
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
      read(),
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
      read(),
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

  it("says why it built next to a hook it looked at, and what the data is about, as it judged them (ticket 17)", async () => {
    const OTHER = "dugout_other_fixtures";
    const final = (extra: Record<string, unknown>) => ({
      toolCalls: [
        {
          name: "final",
          arguments: {
            hookId: HOOK,
            name: "dugout: Rovers fixtures",
            built: true,
            input: {},
            covers: ["venue → data.1[].venue"],
            missing: [],
            why: "Built on the club's connector.",
            ...extra,
          },
        },
      ],
    });
    const { result, refusals } = await runWith(
      [
        call("cast.describeHook", { hookId: OTHER }),
        call("cast.runHook", { hookId: OTHER, applyTransform: true }),
        call("cast.createHook", { id: HOOK, name: "dugout: Rovers fixtures" }),
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
        read(),
        final({}),
        final({ existing: `${OTHER}'s data is about another team` }),
        final({
          existing: `${OTHER}'s data is about another team`,
          about: { reading: "unknown", why: "the output names no team, only a venue" },
        }),
      ],
      { must: { team: "Zzyzx Rovers" } },
    );
    expect(refusals).toEqual([
      expect.stringContaining(`You built ${HOOK} after looking at ${OTHER}: say in existing why`),
      expect.stringContaining("say in about whether"),
    ]);
    // the model's judgement is taken as it is: no code reads the data's names over it
    expect(result).toMatchObject({
      status: "completed",
      output: { built: true, about: { reading: "unknown" } },
    });
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
      read(),
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
            covers: ["venue → data.1[].venue"],
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
      expect.stringContaining(`You built ${HOOK} after looking at ${OTHER}: say in existing why`),
    ]);
  });
});

/**
 * A hook built as the design shows its data (tickets 14, 15): the feed's form first, then the
 * design's once the transform derives it. The fake run answers the raw output until the transform
 * set is the derived one, as a real run with the transform applied does.
 */
describe("hook-maker gives what the design shows, in its form and order", () => {
  const HOOK_ID = "dugout_shaped";
  const step = (name: string, args: Record<string, unknown>) => ({
    toolCalls: [{ name, arguments: args }],
  });
  const answer = (covers: string[]) => ({
    toolCalls: [
      {
        name: "final",
        arguments: {
          hookId: HOOK_ID,
          name: "dugout: shaped",
          built: true,
          input: {},
          covers,
          missing: [],
          why: "Built on the feed's connector.",
        },
      },
    ],
  });
  const shapedRun = (output: unknown) => ({
    text: `RUN  r  hook=${HOOK_ID}  status=ok\n\nOUTPUT  (transform applied)\n  ${JSON.stringify(output)}`,
    structured: {
      runId: "r",
      hookId: HOOK_ID,
      status: "ok",
      durationMs: 1,
      steps: [],
      outputComputed: true,
      output,
      budget: { remaining: 20, used: 1 },
    },
    isError: false,
  });

  const build = async (
    need: Record<string, unknown>,
    raw: unknown,
    shaped: unknown,
    covers: string[],
  ) => {
    let transform = "$";
    const hub = cast({
      cast_set_transform: (args) => {
        transform = String(args.expression);
        return "Saved.";
      },
      cast_run_hook: (args) =>
        args.applyTransform === true ? shapedRun(transform === "$" ? raw : shaped) : ran(false),
    });
    const pass = (expression: string) => [
      step("cast.setTransform", { hookId: HOOK_ID, mode: "whole", expression }),
      step("cast.runHook", { hookId: HOOK_ID, applyTransform: true }),
      step("cast.publishHook", { hookId: HOOK_ID }),
      step("hook.evidence", { hookId: HOOK_ID, covers }),
      answer(covers),
    ];
    const model = createScriptedModel([
      step("cast.createHook", { id: HOOK_ID, name: "dugout: shaped" }),
      step("cast.addStep", {
        hookId: HOOK_ID,
        kind: "api_call",
        apiId: "fanxp-seed-api-cricket-schedule",
        connectFrom: "input",
        connectTo: "output",
      }),
      ...pass("$"),
      ...pass("( derived )"),
    ]);
    const result = await agent.create({
      store: createMemoryStore({ pool, embeddings: createHashEmbeddings() }),
      client: model,
      models: scriptedModelConfig(),
      runsDir: await mkdtemp(join(tmpdir(), "runs-")),
      consolidate: false,
      mcp: createMcpHost({ hub }),
    })({
      tenantId: "demo-cricket",
      input: { need: { count: "data", ...need } as never },
      responder: async () => approve("editor"),
    });
    const said = model.requests.map((r) => String(r.messages.at(-1)?.content));
    const refusals = said.filter((m) => m.startsWith("Not accepted"));
    // what hook.evidence answered, each time it was read
    const evidence = said
      .filter((m) => m.startsWith(`{"hookId":"${HOOK_ID}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);
    return { result, refusals, evidence };
  };

  it("a unit converted: the values beside the example, for the model to judge, never refused", async () => {
    const { result, refusals, evidence } = await build(
      {
        list: "players",
        item: [{ field: "shooting", required: true, kind: "number", example: "45%" }],
      },
      { players: [{ shooting: "0.452" }, { shooting: "0.381" }] },
      { players: [{ shooting: "45" }, { shooting: "38" }] },
      ["shooting → players[].shooting"],
    );
    // the form is the model's call: what it answers is taken, and the evidence showed both
    expect(refusals).toEqual([]);
    expect(evidence[0]).toMatchObject({
      fields: [{ field: "shooting", example: "45%", values: ["0.452", "0.381"] }],
    });
    expect(result).toMatchObject({ status: "completed", output: { hookId: HOOK_ID } });
  });

  it("one field split: a full name the design draws on two lines", async () => {
    const { result, refusals } = await build(
      {
        list: "players",
        item: [
          { field: "first name", required: true, example: "Erling" },
          { field: "last name", required: true, example: "Haaland" },
        ],
      },
      { players: [{ name: "Erling Haaland" }, { name: "Phil Foden" }] },
      {
        players: [
          { name: "Erling Haaland", first: "Erling", last: "Haaland" },
          { name: "Phil Foden", first: "Phil", last: "Foden" },
        ],
      },
      ["first name → players[].first", "last name → players[].last"],
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('covers "first name" at players[].first');
    expect(result).toMatchObject({ status: "completed" });
  });

  it("a code made a word: an event's state as the design writes it", async () => {
    const { result, refusals } = await build(
      {
        list: "events",
        item: [{ field: "status", required: true, example: "Sold out" }],
      },
      { events: [{ code: "S" }, { code: "A" }] },
      {
        events: [
          { code: "S", status: "Sold out" },
          { code: "A", status: "On sale" },
        ],
      },
      ["status → events[].status"],
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('covers "status" at events[].status');
    expect(result).toMatchObject({ status: "completed" });
  });

  it("fields by kind of item: each player's card shows the stat of its role", async () => {
    const shaped = {
      players: [
        { role: "forward", stats: [{ label: "Goals", value: "12" }] },
        { role: "keeper", stats: [{ label: "Saves", value: "40" }] },
      ],
    };
    const { result, refusals } = await build(
      {
        list: "players",
        item: [
          {
            field: "stat",
            required: true,
            kind: "number",
            example: "12",
            alternatives: ["Goals", "Saves"],
          },
        ],
      },
      { players: [{ role: "forward", goals: "12" }, { role: "keeper" }] },
      shaped,
      ["stat → players[].stats[].value"],
    );
    expect(refusals).toHaveLength(1);
    expect(result).toMatchObject({ status: "completed" });
  });

  it("which items in what order: the dates in output order, for the model to judge, never refused", async () => {
    const day = (date: string, ...kickoffs: string[]) => ({
      date,
      matches: kickoffs.map((kickoff) => ({ kickoff, venue: "Ground" })),
    });
    const { result, refusals, evidence } = await build(
      {
        list: "fixtures",
        groupBy: "date",
        order: "soonest-first",
        item: [{ field: "venue", required: true }],
      },
      {
        days: [
          day("2030-08-02", "2030-08-02T19:00:00Z"),
          day("2030-07-30", "2030-07-30T15:00:00Z", "2030-07-30T19:00:00Z"),
        ],
      },
      {
        days: [
          day("2030-07-30", "2030-07-30T15:00:00Z", "2030-07-30T19:00:00Z"),
          day("2030-08-02", "2030-08-02T19:00:00Z"),
        ],
      },
      ["venue → days[].matches[].venue", "order → days[].matches[].kickoff"],
    );
    expect(refusals).toEqual([]);
    expect(evidence[0]).toMatchObject({
      order: {
        order: "soonest-first",
        path: "days[].matches[].kickoff",
        groups: [
          {
            dates: ["2030-08-02T19:00:00Z", "2030-07-30T15:00:00Z", "2030-07-30T19:00:00Z"],
            runs: "both ways",
            after: 3,
          },
        ],
      },
      count: {
        lists: [
          { list: "days[]", items: 2 },
          { list: "days[].matches[]", items: 3 },
        ],
      },
    });
    expect(result).toMatchObject({ status: "completed" });
  });
});

describe("an existing hook on the feeds a person gave (ticket 17 review)", () => {
  const FEED = "https://media.example.net/v1/clips?channel=7";
  const OTHER = "dugout_clips";
  const NEW = "dugout_clips_two";
  it("is a hook it looked at: a copy needs a reason, whatever its data names", async () => {
    const hub = cast({
      cast_describe_hook: (args) => ({
        text: `HOOK  ${args.hookId}\nSTEPS\n  n1  apiCall\n      GET {{env.base_url}}/v1/clips\n      provider: "dugout: media.example.net" — base https://media.example.net\n      overrides: channel=7`,
        structured: {
          id: args.hookId,
          name: "x",
          status: "published",
          readOnly: true,
          callsHooks: false,
        },
        isError: false,
      }),
    });
    const call = (name: string, args: Record<string, unknown>) => ({
      toolCalls: [{ name, arguments: args }],
    });
    const final = (existing?: string) => ({
      toolCalls: [
        {
          name: "final",
          arguments: {
            hookId: NEW,
            name: "dugout: clips",
            built: true,
            input: {},
            covers: ["venue → data.1[].venue"],
            missing: [],
            why: "Built.",
            about: { reading: "design", why: "the person's own feed" },
            ...(existing ? { existing } : {}),
          },
        },
      ],
    });
    const model = createScriptedModel([
      call("cast.describeHook", { hookId: OTHER }),
      call("cast.runHook", { hookId: OTHER, applyTransform: true }),
      call("cast.createHook", { id: NEW, name: "dugout: clips" }),
      call("cast.setTransform", { hookId: NEW, mode: "whole", expression: "$" }),
      call("cast.runHook", { hookId: NEW, applyTransform: true }),
      call("cast.publishHook", { hookId: NEW }),
      call("hook.evidence", { hookId: NEW, covers: ["venue → data.1[].venue"] }),
      final(),
      final(`${OTHER} has no venue`),
    ]);
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
        need: {
          list: "clips",
          count: "data",
          item: [{ field: "venue", required: true }],
          must: { team: "Zzyzx Rovers" },
          sources: [{ label: "clips", url: FEED }],
        },
      },
      responder: async () => approve("editor"),
    });
    const refusals = model.requests
      .map((r) => String(r.messages.at(-1)?.content))
      .filter((m) => m.startsWith("Not accepted"));
    expect(refusals).toEqual([
      expect.stringContaining(`after looking at ${OTHER}: say in existing`),
    ]);
    expect(result).toMatchObject({ status: "completed", output: { basis: "sources" } });
  });
});
