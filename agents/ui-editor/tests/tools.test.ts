import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { completeFinal, listedCommentIds, publishedIn, verifyFinal } from "../src/agent.ts";
import type { CommentSource, UiComment } from "../src/comments.ts";
import { loadDsl, type Tree } from "../src/dsl.ts";
import { applyEdits, createEditTools, type Edit, outline, previewOf } from "../src/tools.ts";

const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000001";
const PREVIEW = `http://localhost:3000/preview/default/${TREE_ID}?theme=t1&surfaces=s1`;

const tree: Tree = {
  schemaVersion: "1.0.0",
  nodes: [
    {
      id: "row",
      parent: null,
      idx: 0,
      type: "Stack",
      src: "1:1",
      props: { direction: "row", gap: "space.2", size: { w: "full" } },
    },
    {
      id: "title",
      parent: "row",
      idx: 0,
      type: "Text",
      src: "1:2",
      props: { content: "Fixtures", style: "type.dp_4_regular" },
    },
    {
      id: "cta",
      parent: "row",
      idx: 1,
      type: "Stack",
      src: "1:3",
      props: { gap: { base: "space.1", lg: "space.4" } },
    },
  ],
};

const comment = (over: Partial<UiComment> = {}): UiComment => ({
  id: "c1",
  nodeId: "row",
  src: "1:1",
  nodeType: "Stack",
  path: "row",
  body: "Too cramped, give it room",
  status: "open",
  context: {},
  ...over,
});

function harness(comments: UiComment[] = [comment()]) {
  const uploads: Array<{ kind: string; json: unknown; meta: Record<string, unknown> }> = [];
  const marked: Array<{ ids: string[]; runId: string }> = [];
  const asked: string[] = [];
  const tools = createEditTools({
    dir: "",
    plane: () => ({
      json: async () => structuredClone(tree),
      upload: async (kind, json, meta) => {
        uploads.push({ kind, json, meta });
        return "tree-2";
      },
    }),
    comments: (tenant, project, ref) => {
      asked.push(`${tenant}/${project}/${ref}`);
      return {
        open: async () => comments,
        sent: async (ids, runId) => void marked.push({ ids, runId }),
      } satisfies CommentSource;
    },
  });
  return { tools, uploads, marked, asked };
}

/** What the tools here return, loosely: a test reads whichever fields it needs. */
// biome-ignore lint/suspicious/noExplicitAny: loose on purpose
type Out = Record<string, any>;
const toolOf = (tools: { name: string }[], name: string) =>
  tools.find((t) => t.name === name) as unknown as Tool<unknown, Out, unknown>;
const ctx = async (): Promise<ToolContext> => ({
  tenantId: "demo-cricket",
  runId: `run-${Math.random().toString(36).slice(2)}`,
  signal: new AbortController().signal,
  input: { preview: PREVIEW },
});

const set = (node: string, path: string, value: unknown): Edit => ({
  node,
  op: "set",
  path,
  value: JSON.stringify(value),
});

describe("previewOf", () => {
  it("takes the project and the tree out of the link", () => {
    expect(previewOf(PREVIEW)).toMatchObject({ project: "default", tree: TREE_ID });
  });
  it("refuses a link that is not a tree's preview", () => {
    expect(() => previewOf("http://x/preview/default/run-1")).toThrow(/not a preview link/);
  });
});

describe("applyEdits", () => {
  it("sets a prop and says what changed", async () => {
    const dsl = await loadDsl();
    const r = applyEdits(dsl, tree, [set("row", "gap", "space.6")]);
    expect(r.problems).toEqual([]);
    expect(r.changes).toEqual([{ node: "row", path: "gap", before: "space.2", after: "space.6" }]);
    expect(r.tree.nodes.find((n) => n.id === "row")?.props.gap).toBe("space.6");
    // the tree it was given is untouched
    expect(tree.nodes[0]?.props.gap).toBe("space.2");
  });

  it("sets inside an object and inside a responsive prop's base", async () => {
    const dsl = await loadDsl();
    const r = applyEdits(dsl, tree, [
      set("row", "size.h", "auto"),
      set("cta", "gap.base", "space.3"),
    ]);
    expect(r.problems).toEqual([]);
    expect(r.tree.nodes.find((n) => n.id === "cta")?.props.gap).toEqual({
      base: "space.3",
      lg: "space.4",
    });
  });

  it("unsets a prop and removes a node", async () => {
    const dsl = await loadDsl();
    const r = applyEdits(dsl, tree, [
      { node: "row", op: "unset", path: "gap", value: "" },
      { node: "cta", op: "remove", path: "", value: "" },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.tree.nodes.some((n) => n.id === "cta")).toBe(false);
    expect("gap" in (r.tree.nodes.find((n) => n.id === "row")?.props ?? {})).toBe(false);
  });

  it("names a prop the type does not have, with what it takes", async () => {
    const dsl = await loadDsl();
    const r = applyEdits(dsl, tree, [set("row", "colour", "red")]);
    expect(r.problems[0]).toMatch(/a Stack has no prop "colour".*gap/);
    expect(r.changes).toEqual([]);
  });

  it("names a value of the wrong kind, a missing node and bad JSON", async () => {
    const dsl = await loadDsl();
    const wrong = applyEdits(dsl, tree, [set("row", "direction", "diagonal")]);
    expect(wrong.problems.join()).toMatch(/row: direction/);
    expect(applyEdits(dsl, tree, [set("nope", "gap", "space.1")]).problems[0]).toMatch(
      /no node "nope"/,
    );
    expect(
      applyEdits(dsl, tree, [{ node: "row", op: "set", path: "gap", value: "space.4" }])
        .problems[0],
    ).toMatch(/not JSON/);
  });

  it("does not remove the root", async () => {
    const dsl = await loadDsl();
    expect(
      applyEdits(dsl, tree, [{ node: "row", op: "remove", path: "", value: "" }]).problems[0],
    ).toMatch(/root/);
  });

  it("does not blame the edits for what the node already had wrong", async () => {
    const dsl = await loadDsl();
    const odd: Tree = {
      ...tree,
      nodes: tree.nodes.map((n) =>
        n.id === "row" ? { ...n, props: { ...n.props, direction: "diagonal" } } : n,
      ),
    };
    expect(applyEdits(dsl, odd, [set("row", "gap", "space.6")]).problems).toEqual([]);
  });
});

describe("outline", () => {
  it("lists the tree with the words each node shows", () => {
    expect(outline(tree)).toEqual(["row (Stack)", '  title (Text) "Fixtures"', "  cta (Stack)"]);
  });
});

describe("the tools", () => {
  it("ui.load reads the comments of the run's own tenant, project and tree, with their elements", async () => {
    const { tools, asked } = harness([
      comment({ context: { draft: { changed: ["gap"], was: { gap: "space.1" } } } }),
      comment({ id: "c2", nodeId: "ghost" }),
    ]);
    const out = await toolOf(tools, "ui.load").run({}, await ctx());
    expect(asked).toEqual([`demo-cricket/default/${TREE_ID}`]);
    expect(out.comments[0]).toMatchObject({
      id: "c1",
      node: "row",
      element: { type: "Stack", children: [{ id: "title" }, { id: "cta" }] },
    });
    expect(out.comments[0].onScreen.draftedEdits).toEqual(["gap"]);
    expect(out.comments[1].missing).toMatch(/not in the tree/);
    expect(out.outline[0]).toBe("row (Stack)");
  });

  it("keeps a picture out of the model's context, and out of the way of an edit", async () => {
    const picture = `data:image/png;base64,${"A".repeat(500_000)}`;
    const withPicture: Tree = {
      ...tree,
      nodes: [
        ...tree.nodes,
        {
          id: "logo",
          parent: "row",
          idx: 2,
          type: "Image",
          src: "1:4",
          props: { src: picture, alt: "Club" },
        },
      ],
    };
    const uploads: Tree[] = [];
    const tools = createEditTools({
      dir: await mkdtemp(join(tmpdir(), "ui-editor-")),
      plane: () => ({
        json: async () => structuredClone(withPicture),
        upload: async (_k, json) => {
          uploads.push(json as Tree);
          return "tree-2";
        },
      }),
      comments: () => ({
        open: async () => [
          comment({
            nodeId: "logo",
            context: { draft: { changed: ["src"], was: { src: picture } } },
          }),
        ],
        sent: async () => {},
      }),
    });
    const c = await ctx();
    const loaded = await toolOf(tools, "ui.load").run({}, c);
    expect(JSON.stringify(loaded).length).toBeLessThan(16_000);
    expect(loaded.comments[0].element.props.src).toBe("<picture png, 488 KB>");
    expect(
      JSON.stringify(await toolOf(tools, "ui.node").run({ id: "logo" }, c)).length,
    ).toBeLessThan(16_000);

    // the handle is not a value to write back
    const bad = await toolOf(tools, "ui.try").run(
      { edits: [set("logo", "src", "<picture png, 488 KB>")] },
      c,
    );
    expect(bad.problems[0]).toMatch(/stands for a picture/);

    // another prop is edited and the picture stays as it was
    const tried = await toolOf(tools, "ui.try").run({ edits: [set("logo", "alt", "Crest")] }, c);
    expect(tried.problems).toEqual([]);
    await toolOf(tools, "ui.publish").run({}, c);
    const logo = uploads[0]?.nodes.find((n) => n.id === "logo");
    expect(logo?.props).toEqual({ src: picture, alt: "Crest" });
  });

  it("ui.try then ui.publish stores the edited tree, marks the comments sent, and links the new tree", async () => {
    const h = harness();
    const c = await ctx();
    const dir = await mkdtemp(join(tmpdir(), "ui-editor-"));
    const tools = createEditTools({
      dir,
      plane: () => ({
        json: async () => structuredClone(tree),
        upload: async (kind, json, meta) => {
          h.uploads.push({ kind, json, meta });
          return "tree-2";
        },
      }),
      comments: () => ({
        open: async () => [comment()],
        sent: async (ids, runId) => void h.marked.push({ ids, runId }),
      }),
    });
    const publish = toolOf(tools, "ui.publish");

    expect(publish.block?.({}, c)).toMatch(/Nothing to publish/);
    const tried = await toolOf(tools, "ui.try").run({ edits: [set("row", "gap", "space.6")] }, c);
    expect(tried.problems).toEqual([]);
    expect(publish.resolve?.({}, c)).toMatchObject({
      changes: [{ node: "row", path: "gap", after: "space.6" }],
    });
    expect(publish.block?.({}, c)).toBeUndefined();

    const out = await publish.run({}, c);
    expect(out).toMatchObject({ treeArtifactId: "tree-2", edits: 1, commentIds: ["c1"] });
    expect(out.previewUrl).toBe(
      `http://localhost:3000/preview/default/tree-2?theme=t1&surfaces=s1`,
    );
    expect(h.uploads[0]).toMatchObject({
      kind: "dsl_tree",
      meta: { source: "dugout:ui-editor", from: TREE_ID, comments: ["c1"] },
    });
    expect(((h.uploads[0]?.json ?? { nodes: [] }) as Tree).nodes[0]?.props.gap).toBe("space.6");
    expect(h.marked).toEqual([{ ids: ["c1"], runId: c.runId }]);
    // a second call returns the first result and writes nothing more
    expect(await publish.run({}, c)).toEqual(out);
    expect(h.uploads).toHaveLength(1);
  });

  it("ui.publish is refused while the edits have problems, twice, then goes through listing them", async () => {
    const h = harness();
    const c = await ctx();
    const dir = await mkdtemp(join(tmpdir(), "ui-editor-"));
    const tools = createEditTools({
      dir,
      plane: () => ({ json: async () => structuredClone(tree), upload: async () => "t" }),
      comments: () => ({ open: async () => [comment()], sent: async () => {} }),
    });
    const publish = toolOf(tools, "ui.publish");
    await toolOf(tools, "ui.try").run({ edits: [set("row", "colour", "red")] }, c);
    expect(publish.block?.({}, c)).toMatch(/Not yet \(1 of 2\)/);
    expect(publish.block?.({}, c)).toMatch(/Not yet \(2 of 2\)/);
    expect(publish.block?.({}, c)).toBeUndefined();
    void h;
  });
});

describe("the final answer", () => {
  const msgs = (publish: unknown, load: unknown) =>
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "ui.load", input: {} },
          { id: "b", name: "ui.publish", input: {} },
        ],
      },
      { role: "tool", toolCallId: "a", content: JSON.stringify(load) },
      { role: "tool", toolCallId: "b", content: JSON.stringify(publish) },
    ] as never;
  const published = {
    previewUrl: "http://x/preview/default/t2",
    treeArtifactId: "t2",
    edits: 2,
    commentIds: ["c1"],
    problems: [],
  };
  const run = { messages: msgs(published, { comments: [{ id: "c1" }, { id: "c2" }] }) };

  it("reads what the tools said", () => {
    expect(publishedIn(run.messages)).toMatchObject({ treeArtifactId: "t2" });
    expect(listedCommentIds(run.messages)).toEqual(["c1", "c2"]);
  });
  it("takes the link and the count from ui.publish, not the model", () => {
    expect(
      completeFinal(
        { previewUrl: "made up", treeArtifactId: "x", edits: 9, comments: [], remaining: [] },
        run,
      ),
    ).toMatchObject({ previewUrl: published.previewUrl, treeArtifactId: "t2", edits: 2 });
  });
  it("wants every comment answered, and something published", () => {
    const one = {
      previewUrl: "",
      treeArtifactId: "",
      edits: 0,
      remaining: [],
      comments: [{ id: "c1", status: "addressed", detail: "gap" }],
    };
    expect(verifyFinal(one, run)).toMatch(/missing 1 comment.*c2/);
    expect(
      verifyFinal(
        {
          ...one,
          comments: [...one.comments, { id: "c2", status: "not-addressed", detail: "needs data" }],
        },
        run,
      ),
    ).toBeUndefined();
    expect(verifyFinal(one, { messages: [] as never })).toMatch(/Nothing was published/);
  });
});
