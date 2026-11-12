import { memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { completeFinal, verifyFinal } from "../src/agent.ts";
import type { CommentSource, UiComment } from "../src/comments.ts";
import { loadDsl, type Tree } from "../src/dsl.ts";
import { historyOf } from "../src/history.ts";
import type { Scene } from "../src/look.ts";
import {
  applyEdits,
  createEditTools,
  DATA,
  type Edit,
  LISTED_COMMENTS,
  outline,
  type Plane,
  PUBLISHED,
  previewOf,
} from "../src/tools.ts";
import type { Version } from "../src/versions.ts";

const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000001";
const EDITED = "6f0e8c1a-0000-4000-8000-000000000002";
const PLAN_ID = "6f0e8c1a-0000-4000-8000-0000000000a1";
const PREVIEW = `http://localhost:3000/preview/default/${TREE_ID}?theme=t1&surfaces=s1&width=375`;

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

interface Harness {
  tools: ReturnType<typeof createEditTools>;
  uploads: Array<{ kind: string; json: unknown; meta: Record<string, unknown> }>;
  marked: Array<{ ids: string[]; runId: string }>;
  asked: Array<{ at: string; runId?: string; ids?: readonly string[] }>;
  versions: Version[];
  shots: Array<{ scene: Scene; node: string }>;
}

function harness(
  opts: {
    comments?: UiComment[];
    tree?: Tree;
    artifacts?: Record<string, unknown>;
    metas?: Record<string, Record<string, unknown>>;
    memory?: Parameters<typeof createEditTools>[0] extends infer O
      ? O extends { memory?: infer M }
        ? M
        : never
      : never;
  } = {},
): Harness {
  const h: Harness = {
    tools: [] as never,
    uploads: [],
    marked: [],
    asked: [],
    versions: [],
    shots: [],
  };
  const plane = (): Plane => ({
    json: async (id) =>
      structuredClone(id === TREE_ID ? (opts.tree ?? tree) : (opts.artifacts?.[id] ?? tree)),
    meta: async (id) =>
      opts.metas?.[id] ?? {
        irArtifactId: "ir-1",
        content: { data: "some" },
        source: "frame-match",
      },
    upload: async (kind, json, meta) => {
      h.uploads.push({ kind, json, meta });
      return EDITED;
    },
  });
  h.tools = createEditTools({
    plane,
    comments: (tenant, project, ref, section) => {
      const at = `${tenant}/${project}/${ref}${section ? `#${section}` : ""}`;
      return {
        open: async (runId, ids) => {
          h.asked.push({ at, ...(runId ? { runId } : {}), ...(ids ? { ids } : {}) });
          return opts.comments ?? [comment()];
        },
        sent: async (ids, runId) => void h.marked.push({ ids, runId }),
        earlier: async () => [
          { nodeId: "row", body: "a bit more room", status: "done", at: "2026-11-01T00:00:00Z" },
        ],
      } satisfies CommentSource;
    },
    versions: { add: async (_t, v) => void h.versions.push(v) },
    shoot: async (scene, node) => {
      h.shots.push({ scene, node });
      return Buffer.from("png");
    },
    see: async (_png, prompt) => `seen: ${prompt.split("\n")[1]}`,
    ...(opts.memory ? { memory: opts.memory } : {}),
  });
  return h;
}

/** What the tools here return, loosely: a test reads whichever fields it needs. */
// biome-ignore lint/suspicious/noExplicitAny: loose on purpose
type Out = Record<string, any>;
const toolOf = (tools: { name: string }[], name: string) =>
  tools.find((t) => t.name === name) as unknown as Tool<unknown, Out, unknown>;
const ctx = (input: Record<string, unknown> = { preview: PREVIEW }): ToolContext => ({
  tenantId: "demo-cricket",
  runId: `run-${Math.random().toString(36).slice(2)}`,
  signal: new AbortController().signal,
  state: memoryRunState(),
  input,
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

  it("inserts a new primitive, wraps, moves and duplicates nodes", async () => {
    const dsl = await loadDsl();
    const r = applyEdits(dsl, tree, [
      {
        node: "row",
        op: "insert",
        path: "0",
        value: JSON.stringify({
          type: "Text",
          props: { content: "New", style: "type.dp_4_regular" },
        }),
      },
      { node: "cta", op: "wrap", path: "", value: JSON.stringify({ type: "Box", props: {} }) },
      { node: "title", op: "move", path: "", value: JSON.stringify({ parent: "row", index: 2 }) },
      { node: "title", op: "duplicate", path: "", value: "" },
    ]);
    expect(r.problems).toEqual([]);
    expect(outline(r.tree)).toEqual([
      "row (Stack)",
      '  new1 (Text) "New"',
      "  wrap1 (Box)",
      "    cta (Stack)",
      '  title (Text) "Fixtures"',
      '  copy1:title (Text) "Fixtures"',
    ]);
    expect(r.changes.map((c) => c.node)).toEqual(["new1", "wrap1", "title", "copy1:title"]);
  });

  it("names a type that is not a primitive, and a move or insert written wrong", async () => {
    const dsl = await loadDsl();
    const bad = applyEdits(dsl, tree, [
      { node: "row", op: "insert", path: "", value: JSON.stringify({ type: "Widget" }) },
      { node: "title", op: "move", path: "", value: JSON.stringify({ to: "row" }) },
      { node: "title", op: "move", path: "", value: JSON.stringify({ parent: "title", index: 0 }) },
    ]);
    expect(bad.problems[0]).toMatch(/"Widget" is not a primitive \(they are: .*Text/);
    expect(bad.problems[1]).toMatch(/\{"parent"/);
    expect(bad.problems[2]).toMatch(/own subtree/);
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

const record = (agent: string, did: unknown, remaining: string[] = []) => ({
  value: {
    v: 1,
    agent,
    agentVersion: 1,
    section: { signature: "sig-fixtures", name: "Fixtures" },
    run: { runId: "r0", at: "2026-11-01T00:00:00Z" },
    did,
    outcome: {
      ended: "completed",
      good: true,
      remaining,
      steps: 4,
      costUsd: 0.1,
      asked: 0,
      approvedBy: "person",
    },
  },
});

describe("an element's history", () => {
  it("is what frame-match and data-bind did to its layer, and what they left open about it", () => {
    const node = { ...(tree.nodes[0] as Tree["nodes"][number]), props: { surface: "surface_row" } };
    const lines = historyOf(
      [
        record(
          "frame-match",
          {
            overrides: [
              { change: { props: [{ src: "1:1", props: { border: null } }] }, gained: 0.4 },
              { change: { surfaces: { surface_row: { fill: "#fff" } } } },
              { change: { props: [{ src: "9:9", props: { gap: 4 } }] } },
            ],
          },
          ["Toggle: the grey border was removed on surface_row to match the design"],
        ),
        record("data-bind", {
          plan: {
            bind: [{ src: "1:1", prop: "content", path: "team.name" }],
            lists: [{ over: "fixtures", as: "f", members: ["1:1", "1:5"], fields: [] }],
            keep: [{ src: "1:1", why: "a heading the designer wrote" }],
            set: [],
          },
        }),
        { value: "not a record" },
      ],
      node,
    );
    expect(lines).toEqual([
      'frame-match set {"border":null} on it to match the design (the match moved +0.4)',
      'frame-match gave its surface surface_row {"fill":"#fff"}',
      "frame-match left open: Toggle: the grey border was removed on surface_row to match the design",
      "data-bind binds content ← {team.name}",
      "data-bind repeats it once for each item of fixtures (as f): it is the card every item draws in, and the 1 other cards the design drew are gone",
      "data-bind keeps it as designed: a heading the designer wrote",
    ]);
  });
});

describe("the tools", () => {
  it("ui.load reads the comments the host handed to the run, with their elements and history", async () => {
    const h = harness({
      comments: [
        comment({ context: { draft: { changed: ["gap"], was: { gap: "space.1" } } } }),
        comment({ id: "c2", nodeId: "ghost" }),
      ],
      memory: {
        buildsOfPreview: async () => [
          record("frame-match", {
            overrides: [{ change: { props: [{ src: "1:1", props: { border: null } }] } }],
          }),
        ],
        lessonsOn: async () => [],
      },
    });
    const c = ctx({
      preview: PREVIEW,
      section: "section-run",
      comments: ["0b8d6a3e-0000-4000-8000-000000000001"],
    });
    const out = await toolOf(h.tools, "ui.load").run({}, c);
    expect(h.asked).toEqual([
      {
        at: `demo-cricket/default/${TREE_ID}#section-run`,
        runId: c.runId,
        ids: ["0b8d6a3e-0000-4000-8000-000000000001"],
      },
    ]);
    expect(out.comments[0]).toMatchObject({
      id: "c1",
      node: "row",
      element: { type: "Stack", children: [{ id: "title" }, { id: "cta" }] },
      history: [
        'frame-match set {"border":null} on it to match the design',
        'asked before 2026-11-01 (done): "a bit more room"',
      ],
    });
    expect(out.comments[0].onScreen.draftedEdits).toEqual(["gap"]);
    expect(out.comments[1].missing).toMatch(/not in the tree/);
    expect(out.outline[0]).toBe("row (Stack)");
    expect(out.preview).toBe(PREVIEW);
    expect(c.state.get(LISTED_COMMENTS)).toEqual(["c1", "c2"]);
  });

  it("ui.load reads what people said about the section before, and says which section the run is on", async () => {
    const asked: string[] = [];
    const h = harness({
      memory: {
        buildsOfPreview: async (tenant, treeId) => {
          asked.push(`${tenant}/${treeId}`);
          return [record("frame-match", {}), { value: "not a record" }];
        },
        lessonsOn: async (tenant, sections) => {
          asked.push(`${tenant}/${sections.join(",")}`);
          return [
            {
              content: 'After this section was built, a person asked: "more room between cards"',
              lastSeenAt: "2026-11-05T10:00:00Z",
              strength: 2,
            },
          ];
        },
      },
    });
    const situated: unknown[] = [];
    const c = { ...ctx(), situate: (s: unknown) => void situated.push(s) };
    const out = await toolOf(h.tools, "ui.load").run({}, c);
    expect(asked).toEqual([`demo-cricket/${TREE_ID}`, "demo-cricket/sig-fixtures"]);
    expect(out.lessons).toEqual([
      '2026-11-05: After this section was built, a person asked: "more room between cards" (2x)',
    ]);
    expect(out.lessonsRule).toMatch(/do not undo one/);
    expect(situated).toEqual([{ section: "sig-fixtures", name: "Fixtures" }]);
  });

  it("ui.load goes on without memory, or when its read fails", async () => {
    const none = await toolOf(harness().tools, "ui.load").run({}, ctx());
    expect(none.lessons).toBeUndefined();
    const failing = harness({
      memory: {
        buildsOfPreview: async () => {
          throw new Error("no database");
        },
        lessonsOn: async () => [],
      },
    });
    const out = await toolOf(failing.tools, "ui.load").run({}, ctx());
    expect(out.lessons).toBeUndefined();
    expect(out.comments).toHaveLength(1);
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
    const h = harness({
      tree: withPicture,
      comments: [
        comment({
          nodeId: "logo",
          context: { draft: { changed: ["src"], was: { src: picture } } },
        }),
      ],
    });
    const c = ctx();
    const loaded = await toolOf(h.tools, "ui.load").run({}, c);
    expect(JSON.stringify(loaded).length).toBeLessThan(16_000);
    expect(loaded.comments[0].element.props.src).toBe("<picture png, 488 KB>");
    expect(
      JSON.stringify(await toolOf(h.tools, "ui.node").run({ id: "logo" }, c)).length,
    ).toBeLessThan(16_000);

    const edit = toolOf(h.tools, "ui.edit");
    const bad = await edit.run(
      { edits: [set("logo", "src", "<picture png, 488 KB>")], data: "" },
      c,
    );
    expect(bad.problems[0]).toMatch(/stands for a picture/);
    expect(h.uploads).toHaveLength(0);

    const ok = await edit.run({ edits: [set("logo", "alt", "Crest")], data: "" }, c);
    expect(ok.published).toBe(true);
    const logo = (h.uploads[0]?.json as Tree | undefined)?.nodes.find((n) => n.id === "logo");
    expect(logo?.props).toEqual({ src: picture, alt: "Crest" });
  });

  it("ui.edit puts clean edits in the preview at once, as a version of the section, with no approval", async () => {
    const h = harness();
    const c = ctx({ preview: PREVIEW, section: "section-run" });
    const edit = toolOf(h.tools, "ui.edit");
    expect(edit.effect).toBe("write");
    expect(edit.noApproval).toBe(true);

    const out = await edit.run({ edits: [set("row", "gap", "space.6")], data: "" }, c);
    expect(out).toMatchObject({ published: true, changes: [{ node: "row", after: "space.6" }] });
    expect(out.previewUrl).toBe(
      `http://localhost:3000/preview/default/${EDITED}?theme=t1&surfaces=s1&width=375`,
    );
    // the tree carries forward what the next run reads of it (its IR), under its own source
    expect(h.uploads[0]).toMatchObject({
      kind: "dsl_tree",
      meta: {
        irArtifactId: "ir-1",
        content: { data: "some" },
        source: "dugout:ui-editor",
        from: TREE_ID,
        comments: ["c1"],
        section: "section-run",
      },
    });
    expect(((h.uploads[0]?.json ?? { nodes: [] }) as Tree).nodes[0]?.props.gap).toBe("space.6");
    expect(h.marked).toEqual([{ ids: ["c1"], runId: c.runId }]);
    expect(h.versions).toEqual([
      expect.objectContaining({
        section: "section-run",
        tree: EDITED,
        surfaces: "s1",
        fromTree: TREE_ID,
        runId: c.runId,
        what: 'row gap → "space.6"',
      }),
    ]);
    expect(c.state.get(PUBLISHED)).toMatchObject({ treeArtifactId: EDITED, edits: 1 });

    // a list with problems publishes nothing, and the preview stays as the last clean one was
    const bad = await edit.run({ edits: [set("row", "colour", "red")], data: "" }, c);
    expect(bad.published).toBe(false);
    expect(h.uploads).toHaveLength(1);
    expect(c.state.get(PUBLISHED)?.treeArtifactId).toBe(EDITED);
    // and ui.look draws the section with the published edits, in the preview's theme and width
    const looked = await toolOf(h.tools, "ui.look").run(
      { node: "row", question: "is there room?" },
      c,
    );
    expect(h.shots).toHaveLength(1);
    expect(h.shots[0]?.node).toBe("row");
    expect(h.shots[0]?.scene.width).toBe(375);
    expect(h.shots[0]?.scene.tree.nodes[0]?.props.gap).toBe("space.6");
    expect(h.shots[0]?.scene.theme).toBeDefined();
    expect(looked.answer).toMatch(/seen: Answer about it/);
  });

  it("ui.edit publishes nothing for no edits", async () => {
    const h = harness();
    const out = await toolOf(h.tools, "ui.edit").run({ edits: [], data: "" }, ctx());
    expect(out.published).toBe(false);
    expect(h.uploads).toHaveLength(0);
  });

  it("ui.edit edits the tree agent.interaction made, and shows it as it is when there is nothing to edit", async () => {
    const behaving = "6f0e8c1a-0000-4000-8000-0000000000c3";
    const plan2 = "6f0e8c1a-0000-4000-8000-0000000000c4";
    const made = structuredClone(tree);
    made.nodes[0] = {
      ...made.nodes[0],
      props: { ...made.nodes[0]?.props, machine: { context: { picked: [] } } },
    } as never;
    const h = harness({
      artifacts: { [behaving]: made, [plan2]: { bind: [] } },
      metas: { [behaving]: { source: "dugout:interaction", from: TREE_ID } },
    });
    const c = ctx();
    const edit = toolOf(h.tools, "ui.edit");
    const link = `http://localhost:3000/preview/default/${behaving}?plan=${plan2}&data=d2`;
    const shown = await edit.run({ edits: [], data: link }, c);
    expect(shown.published).toBe(true);
    expect(shown.previewUrl).toBe(link);
    expect(h.uploads).toHaveLength(0);
    // an edit after it applies to the tree interaction made, machine and all
    const edited = await edit.run({ edits: [set("row", "gap", "space.6")], data: link }, c);
    expect(edited.published).toBe(true);
    const root = (h.uploads[0]?.json as Tree | undefined)?.nodes.find((n) => n.parent === null);
    expect(root?.props.machine).toEqual({ context: { picked: [] } });
  });

  it("ui.edit takes the plan agent.dataBind made, and refuses a link that is not this preview's", async () => {
    const newPlan = "6f0e8c1a-0000-4000-8000-0000000000b2";
    const h = harness({ artifacts: { [newPlan]: { bind: [] }, [PLAN_ID]: { bind: [] } } });
    const c = ctx({ preview: `${PREVIEW}&plan=${PLAN_ID}` });
    const edit = toolOf(h.tools, "ui.edit");
    const wrong = await edit.run(
      {
        edits: [],
        data: "http://localhost:3000/preview/default/6f0e8c1a-0000-4000-8000-0000000000ff?plan=x",
      },
      c,
    );
    expect(wrong.problems[0]).toMatch(
      /not the previewUrl agent.dataBind or agent.interaction returned/,
    );

    const bound = `http://localhost:3000/preview/default/${TREE_ID}?plan=${newPlan}&data=d2`;
    const out = await edit.run({ edits: [], data: bound }, c);
    expect(out.published).toBe(true);
    expect(c.state.get(DATA)).toEqual({ plan: newPlan, data: "d2" });
    const link = new URL(out.previewUrl);
    expect(link.searchParams.get("plan")).toBe(newPlan);
    expect(link.searchParams.get("data")).toBe("d2");
  });

  it("ui.load and ui.node read the page the person saw: the binding plan drawn over the tree", async () => {
    const plan = {
      bind: [{ src: "1:2", prop: "content", path: "team.name" }],
    };
    const h = harness({ artifacts: { [PLAN_ID]: plan } });
    const c = ctx({ preview: `${PREVIEW}&plan=${PLAN_ID}` });
    const out = await toolOf(h.tools, "ui.load").run({}, c);
    expect(out.data).toMatch(/binding plan over the tree/);
    const title = await toolOf(h.tools, "ui.node").run({ id: "title" }, c);
    expect(title.props.content).toBe("{team.name}");
    // edits go on the stored tree, which keeps no binding of its own
    await toolOf(h.tools, "ui.edit").run(
      { edits: [set("title", "style", "type.dp_2_bold")], data: "" },
      c,
    );
    const saved = (h.uploads[0]?.json as Tree | undefined)?.nodes.find((n) => n.id === "title");
    expect(saved?.props).toEqual({ content: "Fixtures", style: "type.dp_2_bold" });
  });
});

describe("the final answer", () => {
  const published = {
    previewUrl: "http://x/preview/default/t2",
    treeArtifactId: "t2",
    edits: 2,
    commentIds: ["c1"],
    problems: [],
  };
  const state = memoryRunState();
  state.set(PUBLISHED, published);
  state.set(LISTED_COMMENTS, ["c1", "c2"]);
  const run = { state };

  it("takes the link and the count from ui.edit, not the model", () => {
    expect(
      completeFinal(
        { previewUrl: "made up", treeArtifactId: "x", edits: 9, comments: [], remaining: [] },
        run,
      ),
    ).toMatchObject({ previewUrl: published.previewUrl, treeArtifactId: "t2", edits: 2 });
  });

  it("is the preview as it was when nothing was published", () => {
    expect(
      completeFinal(
        { previewUrl: "made up", treeArtifactId: "x", edits: 9, comments: [], remaining: [] },
        { state: memoryRunState(), ctx: { input: { preview: PREVIEW } } },
      ),
    ).toMatchObject({ previewUrl: PREVIEW, treeArtifactId: TREE_ID, edits: 0 });
  });

  it("wants every comment answered, and something published for one addressed", () => {
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
    expect(verifyFinal(one, { state: memoryRunState() })).toMatch(/nothing was published/);
    // a run with nothing to do ends without publishing
    expect(verifyFinal({ ...one, comments: [] }, { state: memoryRunState() })).toBeUndefined();
  });
});
