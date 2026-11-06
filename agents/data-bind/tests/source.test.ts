import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@dugout/contracts";
import { REPO_ROOT } from "@dugout/core";
import { createMcpHost } from "@dugout/mcp";
import { fakeHub } from "@dugout/mcp/testing";
import { describe, expect, it } from "vitest";
import { createBindTools, type Plane } from "../src/tools.ts";

const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000001";
const tree = JSON.parse(
  readFileSync(join(REPO_ROOT, "agents/data-bind/tests/fixtures/fixtures-strip.tree.json"), "utf8"),
);

/** The control plane, holding the frame; it keeps what is uploaded. */
const plane = () => {
  const uploads: Array<{ kind: string; json: unknown; meta: Record<string, unknown> }> = [];
  const fake: Plane = {
    json: async () => tree,
    meta: async () => ({}),
    exportIr: async () => {
      throw new Error("no export");
    },
    ir: async () => {
      throw new Error("no IR artifact");
    },
    dataset: async () => {
      throw new Error("this run names no dataset");
    },
    upload: async (kind, json, meta) => {
      uploads.push({ kind, json, meta });
      return `${kind}-1`;
    },
  };
  return { fake, uploads };
};

/** A Cast hook that answers two matches, as the Cricket Schedule hook does. */
const output = {
  data: {
    "1": [
      {
        match_id: "1",
        event_state: "R",
        participants: [{ short_name: "SOB" }, { short_name: "WEF" }],
      },
      {
        match_id: "2",
        event_state: "U",
        participants: [{ short_name: "LNS" }, { short_name: "OVI" }],
      },
    ],
  },
  meta: { pagination: { total: 2 } },
};
/** The hook's public flow id, made up: what a page would fetch it by. */
const WORKFLOW = "7d0c1f9e-0000-4000-8000-000000000002";
/** The Cast server (cast-mcp 0.5), stood in for, behind the real registry: bind reads a hook through the host. */
const cast = () => {
  const hub = fakeHub({
    cast_describe_hook: (args) => ({
      text: "STEPS\n  n1  apiCall\n      GET /schedule",
      structured: {
        id: args.hookId,
        name: "Cricket Schedule",
        status: "published",
        workflowId: WORKFLOW,
        readOnly: true,
        callsHooks: false,
      },
      isError: false,
    }),
    cast_run_hook: () => ({
      text: "RUN  r1  hook=h  status=ok  1ms\n\nOUTPUT  (transform applied)\n  {…}",
      structured: {
        runId: "r1",
        hookId: "h",
        status: "ok",
        durationMs: 1,
        steps: [],
        outputComputed: true,
        output,
        budget: { remaining: 24, used: 1 },
      },
      isError: false,
    }),
  });
  return { mcp: createMcpHost({ hub }), hub };
};

const ctx = (runId: string, data?: string): ToolContext => ({
  tenantId: `bind-${runId}`,
  runId,
  signal: new AbortController().signal,
  input: { preview: `http://localhost:3000/preview/default/${TREE_ID}`, ...(data ? { data } : {}) },
});
const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name) as Tool;

describe("bind's data from Cast", () => {
  it("starts with no data, takes a hook's live output as it, and publishes where it came from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bind-source-"));
    const { fake, uploads } = plane();
    const { mcp, hub } = cast();
    const tools = createBindTools({ dir, plane: () => fake, mcp });
    const run = ctx("run-a");
    // its "not yet" sends the run back to bind.try: asking again must not end the run
    expect(tool(tools, "bind.publish").advisoryBlock).toBe(true);

    const before = (await tool(tools, "bind.load").run({}, run)) as { data: string };
    expect(before.data).toContain("no data yet");
    await expect(tool(tools, "bind.try").run({ plan: "{}" }, run)).rejects.toThrow(/no data yet/);

    const chosen = {
      hookId: "fanxp-seed-hook-cricket-schedule",
      input: { page_size: "2" },
      as: "fixtures",
    };
    const shown = (await tool(tools, "bind.source").run(chosen, run)) as { data: string };
    // the page list is read as items, never data.1
    expect(shown.data).toContain("fixtures.items[]");
    expect(shown.data).not.toContain("data.1");
    expect(hub.calls.map((c) => c.tool)).toEqual(["cast_describe_hook", "cast_run_hook"]);

    const after = (await tool(tools, "bind.load").run({}, run)) as { data: string };
    expect(after.data).toBe(shown.data);
    const tried = (await tool(tools, "bind.try").run({ plan: "{}" }, run)) as { bound: number };
    expect(tried.bound).toBe(0);

    await tool(tools, "bind.publish").run({}, run);
    const data = uploads.find((u) => u.kind === "sample_data");
    expect(data?.json).toMatchObject({ fixtures: { items: output.data["1"] } });
    // with the flow id a page fetches the hook by at render time
    expect(data?.meta.data).toEqual({ kind: "cast-hook", workflowId: WORKFLOW, ...chosen });
    // the source was fetched once: the publish binds what the plan was tried against
    expect(hub.calls).toHaveLength(2);
  });

  it("binds a hook's own shape, grouped as the design groups it, with no page envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bind-source-"));
    const { fake } = plane();
    const grouped = {
      days: [
        {
          date: "22 JULY",
          matches: [{ id: "1", teams: [{ short_name: "SOB" }, { short_name: "WEF" }] }],
        },
        {
          date: "25 JULY",
          matches: [{ id: "3", teams: [{ short_name: "SL" }, { short_name: "SOB" }] }],
        },
      ],
    };
    const hub = fakeHub({
      cast_describe_hook: (args) => ({
        text: "STEPS",
        structured: {
          id: args.hookId,
          name: "Days",
          status: "published",
          readOnly: true,
          callsHooks: false,
        },
        isError: false,
      }),
      cast_run_hook: () => ({
        text: "RUN",
        structured: {
          runId: "r1",
          hookId: "h",
          status: "ok",
          durationMs: 1,
          steps: [],
          outputComputed: true,
          output: grouped,
          budget: { remaining: 24, used: 1 },
        },
        isError: false,
      }),
    });
    const tools = createBindTools({ dir, plane: () => fake, mcp: createMcpHost({ hub }) });
    const shown = (await tool(tools, "bind.source").run(
      { hookId: "dugout_days", as: "fixtures" },
      ctx("run-grouped"),
    )) as { data: string };
    // the lists keep their own names, down to the inner list
    expect(shown.data).toContain("fixtures.days[].date");
    expect(shown.data).toContain("fixtures.days[].matches[].teams[].short_name");
  });

  it("refuses a source when the host named the data", () => {
    const tools = createBindTools({ plane: () => plane().fake, mcp: cast().mcp });
    const refusal = tool(tools, "bind.source").block?.(
      { hookId: "h", as: "fixtures" },
      ctx("run-b", "fixtures-strip"),
    );
    expect(refusal).toContain("given its data");
  });
});
