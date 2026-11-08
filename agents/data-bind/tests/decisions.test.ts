import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Situation, Tool, ToolContext } from "@dugout/contracts";
import { REPO_ROOT } from "@dugout/core";
import type { MemoryItem } from "@dugout/memory";
import { describe, expect, it } from "vitest";
import { spec } from "../src/agent.ts";
import { createBindTools, type Plane } from "../src/tools.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, "agents/data-bind/tests/fixtures", name), "utf8"));
const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000003";

const plane: Plane = {
  json: async () => fixture("news-grid.tree.json"),
  meta: async () => ({ irArtifactId: "ir-1" }),
  exportIr: async () => {
    throw new Error("no export");
  },
  // the frame's own IR names its layers; the whole document (the compiler's fixture, which has
  // layout) is what the section is signed from
  ir: async () => ({
    root: fixture("news-grid.ir.json").root,
    annotations: [],
    doc: JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/compile/fixtures/news-grid.ir.json"), "utf8"),
    ),
  }),
  dataset: async () => {
    throw new Error("no dataset");
  },
  upload: async (kind) => `${kind}-1`,
};

const decision = (over: Partial<MemoryItem>): MemoryItem => ({
  id: "d1",
  tenantId: "t",
  agentId: "hook-maker",
  kind: "episodic",
  key: "hook-maker:hook_choice@sig",
  episodeType: "decision",
  version: 1,
  content: 'On "Frame 1984078918", Sagar Chavan answered "Use the hook or build?": use_existing.',
  status: "active",
  confidence: 1,
  strength: 1,
  sourceRunId: "r",
  reviewedBy: null,
  createdAt: "2026-11-07T12:37:56.000Z",
  lastSeenAt: "2026-11-07T12:37:56.000Z",
  expiresAt: null,
  sharedScope: null,
  sources: [],
  value: "use_existing",
  ...over,
});

describe("bind.load and what a person decided before (ADR 0033)", () => {
  it("says which section the run works on, and lists what was decided about it", async () => {
    let situated: Situation | undefined;
    const asked: string[] = [];
    const tools = createBindTools({
      dir: await mkdtemp(join(tmpdir(), "bind-decisions-")),
      plane: () => plane,
      decisions: {
        decisionsOn: async (_tenant, section) => {
          asked.push(section);
          return [decision({})];
        },
      },
    });
    const ctx: ToolContext = {
      tenantId: "t",
      runId: "run-d",
      signal: new AbortController().signal,
      input: { preview: `http://localhost:3000/preview/default/${TREE_ID}` },
      situate: (s) => {
        situated = s;
      },
    };
    const load = tools.find((t) => t.name === "bind.load") as Tool;
    const out = (await load.run({}, ctx)) as { before?: string[]; beforeRule?: string };
    expect(situated?.section).toBe("s2:324766a5bec48384");
    expect(asked).toEqual([situated?.section]);
    expect(out.before).toEqual([
      expect.stringContaining("2026-11-07 hook-maker hook_choice: use_existing."),
    ]);
    expect(out.beforeRule).toMatch(/Keep to them/);
  });

  it("names only declared questions in its skill", () => {
    const skill = readFileSync(join(REPO_ROOT, "agents/data-bind/skills/bind.md"), "utf8");
    const listed =
      /Give each question the id `ask` lists for it \(([^)]*)\)/.exec(skill)?.[1] ?? "";
    const ids = [...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.sort()).toEqual(Object.keys(spec.questions ?? {}).sort());
  });
});
