import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { REPO_ROOT } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { createBindTools, type Plane, RunInput } from "../src/tools.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, "agents/data-bind/tests/fixtures", name), "utf8"));
const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000003";
const PLAN = { bind: [{ src: "1:2", prop: "content", path: "player.name" }] };

const plane: Plane = {
  json: async (id) => (id === "plan-1" ? PLAN : fixture("news-grid.tree.json")),
  meta: async (id) =>
    id === "data-1"
      ? { sources: [{ as: "squad", hookId: "dugout_squad" }] }
      : { irArtifactId: "ir-1" },
  exportIr: async () => {
    throw new Error("no export");
  },
  ir: async () => ({ root: fixture("news-grid.ir.json").root, annotations: [] }),
  dataset: async () => {
    throw new Error("no dataset");
  },
  upload: async (kind) => `${kind}-1`,
};

const load = async (input: unknown) => {
  const tools = createBindTools({
    dir: await mkdtemp(join(tmpdir(), "bind-request-")),
    plane: () => plane,
  });
  const ctx: ToolContext = {
    tenantId: "t",
    runId: `run-${Math.random()}`,
    signal: new AbortController().signal,
    state: memoryRunState(),
    input,
  };
  return (await (tools.find((t) => t.name === "bind.load") as Tool).run({}, ctx)) as Record<
    string,
    unknown
  >;
};

describe("a person's request about the data (from ui-editor's comments)", () => {
  const preview = `http://localhost:3000/preview/default/${TREE_ID}?plan=plan-1&data=data-1`;

  it("is part of the input, and bind.load gives it with the plan and sources the preview has now", async () => {
    const input = RunInput.parse({ preview, request: "on name (Text, src 1:2): surname only" });
    const out = await load(input);
    expect(out.request).toBe("on name (Text, src 1:2): surname only");
    expect(JSON.parse(out.current as string)).toEqual(PLAN);
    expect(out.currentSources).toEqual([{ as: "squad", hookId: "dugout_squad" }]);
    expect(out.requestRule).toMatch(/start from that plan/);
  });

  it("is not there when the run was not given one", async () => {
    const out = await load({ preview });
    expect(out.request).toBeUndefined();
    expect(out.current).toBeUndefined();
  });
});
