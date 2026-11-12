/**
 * ix.load and ix.apply on a fake control plane: the section is read once, the behaviours become a
 * new tree and plan, and the preview link and the section's version name them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { completeFinal } from "../src/agent.ts";
import type { Plane, Version } from "../src/store.ts";
import { createInteractionTools, PUBLISHED } from "../src/tools.ts";

const fixture = (f: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `fixtures/select-players.${f}.json`), "utf8"));
const TREE = "8ae066d1-462e-41e0-9fb2-89486759e2d7";
const PLAN = "6cf1a40a-8798-4c10-9bcf-f3d363cf89d0";
const DATA = "799421af-e3c3-4326-b6a9-ea9056740416";
const IR = "dcf73bb3-266f-47ff-85f5-80a40796ad39";
const PREVIEW = `http://localhost:3000/preview/default/${TREE}?theme=t&surfaces=s&width=375&plan=${PLAN}&data=${DATA}`;

function plane() {
  const stored = new Map<string, unknown>([
    [TREE, fixture("tree")],
    [PLAN, fixture("plan")],
    [DATA, fixture("data")],
    [IR, fixture("ir")],
  ]);
  const uploads: Array<{ kind: string; json: unknown; meta: Record<string, unknown> }> = [];
  const p: Plane = {
    json: async (id) => {
      if (!stored.has(id)) throw new Error(`no ${id}`);
      return structuredClone(stored.get(id));
    },
    meta: async (id) => (id === TREE ? { irArtifactId: IR, handoffId: "h1" } : {}),
    upload: async (kind, json, meta) => {
      uploads.push({ kind, json, meta });
      return `00000000-0000-4000-8000-00000000000${uploads.length}`;
    },
  };
  return { p, uploads };
}

const ctx = (input: Record<string, unknown>): ToolContext => ({
  tenantId: "sb",
  runId: `run-${Math.random().toString(36).slice(2)}`,
  signal: new AbortController().signal,
  state: memoryRunState(),
  input,
});

describe("ix.load and ix.apply", () => {
  it("reads the evidence, then publishes the section with its behaviour as a version", async () => {
    const { p, uploads } = plane();
    const versions: Version[] = [];
    const seen: number[] = [];
    const [load, apply] = createInteractionTools({
      plane: () => p,
      see: async (png) => {
        seen.push(png.length);
        return "a small picture";
      },
      versions: { add: async (_t, v) => void versions.push(v) },
    }) as [Tool, Tool];
    const c = ctx({
      preview: PREVIEW,
      section: "run-section",
      request: "make the search work (on input)",
    });
    const evidence = (await load.run({}, c)) as {
      fields: unknown[];
      overflow: unknown[];
      request?: string;
      lists: Array<{ differences: Array<{ groups: Array<{ shows?: string }> }> }>;
    };
    // each picture that differs by card is described once, for the model to read
    const described = evidence.lists[0]?.differences
      .flatMap((d) => d.groups)
      .filter((g) => g.shows);
    expect(described?.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(12);
    expect(evidence.fields).toHaveLength(1);
    expect(evidence.overflow).toHaveLength(1);
    expect(evidence.request).toContain("search");

    const out = (await apply.run(
      {
        toggles: [],
        show: [],
        restyle: [],
        search: [{ field: "search", over: "squad.players", path: "name" }],
        scroll: [{ src: "551:13362", axis: "y" }],
      },
      c,
    )) as { published: boolean; previewUrl: string; notes: string[] };
    expect(out.published).toBe(true);
    expect(uploads.map((u) => u.kind)).toEqual(["dsl_tree", "binding_plan"]);
    expect(uploads[0]?.meta).toMatchObject({
      irArtifactId: IR,
      source: "dugout:interaction",
      from: TREE,
    });
    const link = new URL(out.previewUrl);
    expect(link.pathname).toBe("/preview/default/00000000-0000-4000-8000-000000000001");
    expect(link.searchParams.get("plan")).toBe("00000000-0000-4000-8000-000000000002");
    expect(link.searchParams.get("data")).toBe(DATA);
    expect(versions[0]).toMatchObject({
      section: "run-section",
      tree: "00000000-0000-4000-8000-000000000001",
      data: DATA,
    });
    expect(c.state.get(PUBLISHED)?.previewUrl).toBe(out.previewUrl);
    expect(completeFinal({ settled: [], remaining: [] }, { state: c.state })).toMatchObject({
      previewUrl: out.previewUrl,
      behaviours: out.notes,
    });
  });

  it("publishes nothing when the behaviours name what is not there", async () => {
    const { p, uploads } = plane();
    const [, apply] = createInteractionTools({ plane: () => p, see: false }) as [Tool, Tool];
    const out = (await apply.run(
      {
        toggles: [],
        show: [],
        restyle: [],
        search: [{ field: "q", over: "squad.players", path: "name" }],
        scroll: [],
      },
      ctx({ preview: PREVIEW }),
    )) as { published: boolean; problems: string[] };
    expect(out.published).toBe(false);
    expect(out.problems[0]).toMatch(/no field writes q/);
    expect(uploads).toEqual([]);
  });
});
