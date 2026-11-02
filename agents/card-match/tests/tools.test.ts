import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeFinal, verifyFinal } from "../src/agent.ts";
import type { ControlPlane } from "../src/control-plane.ts";
import type { Built, Bundle, Measurement, Overrides } from "../src/frame.ts";
import { LookInputError } from "../src/look.ts";
import { createMatchTools, type Engine } from "../src/tools.ts";

const measured = (match: number, conformErrors = 0): Measurement => ({
  match,
  comparedPixels: 100,
  coverage: 100,
  estimated: false,
  unchecked: [],
  plates: [],
  conformErrors,
  conformWarnings: 0,
  totalDelta: 0,
  worstDelta: 0,
  placeholderIcons: 0,
  findings: [],
  surfaces: [],
});

const bundle = {
  exportId: "e",
  rootName: "Frame",
  themeArtifactId: "theme-1",
  themeRaw: { tokens: {} },
  doc: { rootNodeId: "1", root: { geometry: { bbox: { x: 0, y: 0, w: 100, h: 10 } } } },
  byId: new Map(),
  plates: [{ nodeId: "1", name: "p", png: Buffer.alloc(0) }],
} as unknown as Bundle;

function setup(score: (overrides: Overrides) => Measurement, errors: string[] = []) {
  const uploads: Array<{ kind: string; json: unknown }> = [];
  const built = (overrides: Overrides) =>
    ({
      tree: { schemaVersion: "1", nodes: [] },
      notes: [],
      themeRaw: { extended: true },
      surfaces: { assets: {}, surfaces: {} },
      cropped: [],
      addedTexts: [],
      errors: overrides.props.length ? errors : [],
      missing: [],
      overrides,
    }) as unknown as Built;
  const engine: Engine = {
    bundle: async () => bundle,
    build: async (_b, overrides) => built(overrides),
    measure: async (_b, b) => score((b as unknown as { overrides: Overrides }).overrides),
    firstPass: async (_b, start) => ({
      overrides: { ...start, gradients: ["g"] },
      built: built(start),
      measurement: measured(90),
    }),
  };
  const plane = {
    upload: async (kind: string, json: unknown) => {
      uploads.push({ kind, json });
      return `${kind}-id`;
    },
  } as unknown as ControlPlane;
  return { engine, plane, uploads };
}

const ctx = (runId: string) =>
  ({
    tenantId: "t",
    runId,
    signal: new AbortController().signal,
    input: { exportId: "6f1d2c1e-7a3b-4c7e-9a10-000000000001", project: "default" },
  }) as const;

async function tools(score: (o: Overrides) => Measurement, errors?: string[]) {
  const { engine, plane, uploads } = setup(score, errors);
  const dir = await mkdtemp(join(tmpdir(), "card-match-"));
  const list = createMatchTools({ dir, engine, plane: () => plane, studio: "http://studio" });
  const named = (name: string) => {
    const found = list.find((tool) => tool.name === name);
    if (!found) throw new Error(name);
    return found as unknown as {
      run(input: unknown, c: ReturnType<typeof ctx>): Promise<Record<string, unknown>>;
      resolve(input: unknown, c: ReturnType<typeof ctx>): Record<string, unknown>;
    };
  };
  return { named, uploads, dir };
}

const change = (props: Overrides["props"] = []): Overrides => ({
  icons: {},
  crops: [],
  drops: [],
  gradients: [],
  texts: [],
  surfaces: {},
  props,
});

describe("frame.override", () => {
  it("keeps a change that helps", async () => {
    const { named } = await tools((o) => measured(o.props.length ? 95 : 90));
    await named("frame.load").run({}, ctx("r1"));
    const result = await named("frame.override").run(
      change([{ src: "s", props: { gap: "space.2" } }]),
      ctx("r1"),
    );
    expect(result).toMatchObject({ kept: true, was: 90, match: 95 });
  });

  it("undoes a change that makes it worse", async () => {
    const { named } = await tools((o) => measured(o.props.length ? 80 : 90));
    await named("frame.load").run({}, ctx("r2"));
    const result = await named("frame.override").run(
      change([{ src: "s", props: { gap: "space.2" } }]),
      ctx("r2"),
    );
    expect(result).toMatchObject({ kept: false, match: 90 });
    expect(result.reason).toContain("drop");
    expect(named("frame.publish").resolve({}, ctx("r2")).match).toBe(90);
  });

  it("undoes a change that adds conform errors, however the pixels move", async () => {
    const { named } = await tools((o) =>
      measured(o.props.length ? 99 : 90, o.props.length ? 1 : 0),
    );
    await named("frame.load").run({}, ctx("r3"));
    const result = await named("frame.override").run(
      change([{ src: "s", props: { gap: "space.2" } }]),
      ctx("r3"),
    );
    expect(result).toMatchObject({ kept: false });
    expect(result.reason).toContain("conform");
  });

  it("refuses what the validator refuses, without measuring", async () => {
    const { named } = await tools(() => measured(90), ["V1: unknown token"]);
    await named("frame.load").run({}, ctx("r4"));
    const result = await named("frame.override").run(
      change([{ src: "s", props: { tone: "color.nope" } }]),
      ctx("r4"),
    );
    expect(result).toMatchObject({ kept: false });
    expect(result.reason).toContain("unknown token");
  });

  it("undoes a change that puts a placeholder back", async () => {
    const { named } = await tools((o) => ({
      ...measured(95),
      placeholderIcons: o.props.length ? 1 : 0,
    }));
    await named("frame.load").run({}, ctx("r6"));
    const result = await named("frame.override").run(
      change([{ src: "s", props: { gap: "space.2" } }]),
      ctx("r6"),
    );
    expect(result).toMatchObject({ kept: false });
    expect(result.reason).toContain("placeholder");
  });

  it("gives a rebuild the placements found when the frame was loaded", async () => {
    const { engine, plane } = setup(() => measured(90));
    const seen: unknown[] = [];
    const held = engine.build;
    engine.bundle = async () => ({ ...bundle });
    engine.firstPass = async (b, start) => {
      b.found = new Map([["plate", { dx: -2, dy: -3 }]]);
      return {
        overrides: start,
        built: { tree: { nodes: [] }, cropped: [], addedTexts: [] } as unknown as Built,
        measurement: measured(90),
      };
    };
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const first = createMatchTools({ dir, engine, plane: () => plane });
    const load = first.find((tool) => tool.name === "frame.load") as unknown as {
      run(i: unknown, c: unknown): Promise<unknown>;
    };
    await load.run({}, ctx("r7"));
    // a resume runs in another process, which has only what is on disk
    engine.build = async (b, overrides) => {
      seen.push(b.found?.get("plate"));
      return held(b, overrides);
    };
    const later = createMatchTools({ dir, engine, plane: () => plane });
    const override = later.find((tool) => tool.name === "frame.override") as unknown as {
      run(i: unknown, c: unknown): Promise<unknown>;
    };
    await override.run(change([{ src: "s", props: { gap: "x" } }]), ctx("r7"));
    expect(seen).toEqual([{ dx: -2, dy: -3 }]);
  });

  it("measures two calls in turn, each against the one before", async () => {
    const { named } = await tools((o) => measured(90 + o.props.length));
    await named("frame.load").run({}, ctx("r5"));
    const [a, b] = await Promise.all([
      named("frame.override").run(change([{ src: "a", props: { gap: "x" } }]), ctx("r5")),
      named("frame.override").run(change([{ src: "b", props: { gap: "x" } }]), ctx("r5")),
    ]);
    expect([a?.match, b?.match]).toEqual([91, 92]);
  });
});

describe("every tool's schema", () => {
  /**
   * Bedrock refuses a tool whose parameters include a property with no type: `z.unknown()` becomes
   * `{}`, and the whole run fails before the model says a word. Nothing else in the tests talks to
   * Bedrock, so this is the only place that can catch it.
   */
  const empty = (schema: unknown, path: string): string[] => {
    if (!schema || typeof schema !== "object") return [];
    const node = schema as Record<string, unknown>;
    const here = Object.keys(node).length === 0 ? [path] : [];
    return [
      ...here,
      ...Object.entries((node.properties ?? {}) as Record<string, unknown>).flatMap(([k, v]) =>
        empty(v, `${path}.${k}`),
      ),
    ];
  };

  for (const vision of [true, false]) {
    it(`has no untyped parameter (vision ${vision ? "on" : "off"})`, () => {
      const list = createMatchTools({ vision });
      for (const tool of list) {
        const schema = z.toJSONSchema((tool as unknown as { input: z.ZodType }).input);
        expect(empty(schema, tool.name)).toEqual([]);
      }
    });
  }
});

describe("frame.look", () => {
  const looked = {
    bands: 1,
    differences: [
      {
        where: { x: 10, y: 20, w: 100, h: 30 },
        kind: "text",
        severity: "high",
        what: "the team name is left aligned",
        layers: [{ src: "1:3", type: "Text", name: "MANCHESTER" }],
      },
    ],
  };

  async function withLook(vision?: boolean) {
    const { engine, plane } = setup(() => measured(90));
    let calls = 0;
    engine.look = async () => {
      calls += 1;
      return looked;
    };
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({
      dir,
      engine,
      plane: () => plane,
      ...(vision === undefined ? {} : { vision }),
    });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<Record<string, unknown>>;
      };
    return { list, named, calls: () => calls, dir };
  }

  it("returns what the vision model saw, with the layers under each place", async () => {
    const { named, calls } = await withLook();
    await named("frame.load").run({}, ctx("v1"));
    const result = await named("frame.look").run({}, ctx("v1"));
    expect(calls()).toBe(1);
    expect(result.bands).toBe(1);
    expect(result.differences).toEqual(looked.differences);
  });

  it("answers, without looking, when the run is made without eyes", async () => {
    const { named, calls } = await withLook(false);
    await named("frame.load").run({}, ctx("v3"));
    const result = await named("frame.look").run({}, ctx("v3"));
    expect(result).toMatchObject({ available: false });
    expect(calls()).toBe(0);
  });

  it("refuses to look at a frame no screenshot lines up with", async () => {
    const { engine, plane } = setup(() => measured(90));
    engine.look = async () => looked;
    engine.firstPass = async (_b, start) => ({
      overrides: start,
      built: { tree: { nodes: [] }, cropped: [], addedTexts: [] } as unknown as Built,
      measurement: measured(90),
    });
    const noPlates = { ...bundle, plates: [] } as unknown as Bundle;
    engine.bundle = async () => noPlates;
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({ dir, engine, plane: () => plane });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<unknown>;
      };
    await named("frame.load").run({}, ctx("v2"));
    await expect(named("frame.look").run({}, ctx("v2"))).rejects.toThrow(/no screenshot/i);
  });
});

describe("a frame.look that fails", () => {
  async function withFailingLook(error: Error) {
    const { engine, plane } = setup(() => measured(90));
    let calls = 0;
    engine.look = async () => {
      calls += 1;
      throw error;
    };
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({ dir, engine, plane: () => plane });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<unknown>;
        block(i: unknown, c: unknown): string | undefined;
      };
    return { named, calls: () => calls };
  }

  it("holds a publish for the first failure and lets it go after the second", async () => {
    const { named } = await withFailingLook(new Error("vision model unreachable"));
    await named("frame.load").run({}, ctx("f1"));
    await expect(named("frame.look").run({}, ctx("f1"))).rejects.toThrow(/unreachable/);
    expect(named("frame.publish").block({}, ctx("f1"))).toContain("frame.look");
    await expect(named("frame.look").run({}, ctx("f1"))).rejects.toThrow(
      /no longer held for it.*say in remaining/i,
    );
    expect(named("frame.publish").block({}, ctx("f1"))).toBeUndefined();
  });

  it("does not count a region outside the frame against the vision model", async () => {
    const { named } = await withFailingLook(new LookInputError("region is outside the frame"));
    await named("frame.load").run({}, ctx("f2"));
    for (let i = 0; i < 4; i++) {
      await expect(named("frame.look").run({}, ctx("f2"))).rejects.toThrow(/outside the frame/);
    }
    expect(named("frame.publish").block({}, ctx("f2"))).toContain("frame.look");
  });
});

describe("looking last", () => {
  const finding = {
    nodeId: "n",
    src: "worst",
    type: "Box",
    mismatch: 500,
    off: 40,
    design: "#000000",
    render: "#ffffff",
    notes: [],
    conform: [],
  };

  async function withOrder(order?: "first" | "last") {
    const { engine, plane } = setup(() => measured(80));
    engine.look = async () => ({ bands: 1, differences: [] });
    engine.firstPass = async (_b, start) => ({
      overrides: start,
      built: { tree: { nodes: [] }, cropped: [], addedTexts: [] } as unknown as Built,
      measurement: { ...measured(90), findings: [finding] },
    });
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({
      dir,
      engine,
      plane: () => plane,
      ...(order ? { lookOrder: order } : {}),
    });
    return (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<Record<string, unknown>>;
        description: string;
      };
  }

  it("refuses an early look until the worst findings have been examined", async () => {
    const named = await withOrder("last");
    await named("frame.load").run({}, ctx("o1"));
    await expect(named("frame.look").run({}, ctx("o1"))).rejects.toThrow(/last check/);
    (bundle.byId as Map<string, unknown>).set("worst", { id: "worst", children: [] });
    await named("frame.node").run({ src: "worst" }, ctx("o1"));
    await expect(named("frame.look").run({}, ctx("o1"))).resolves.toMatchObject({ bands: 1 });
  });

  it("allows a look at any time by default", async () => {
    const named = await withOrder();
    await named("frame.load").run({}, ctx("o2"));
    await expect(named("frame.look").run({}, ctx("o2"))).resolves.toMatchObject({ bands: 1 });
  });

  it("says in the tool's own description when to call it", async () => {
    expect((await withOrder("last"))("frame.look").description).toContain("LAST");
    expect((await withOrder("first"))("frame.look").description).toContain("after frame.load");
  });
});

describe("the look gate and unpainted layers", () => {
  const unpainted = {
    src: "root",
    name: "Match card",
    paint: "gradient/prim/prim_sec_horiz_1",
    token: "gradient.prim_sec_horiz_1",
  };

  async function withEngine(opts: { look?: boolean; vision?: boolean; unpainted?: boolean }) {
    const { engine, plane } = setup(() => measured(90));
    if (opts.look) engine.look = async () => ({ bands: 1, differences: [] });
    if (opts.unpainted) engine.unpainted = () => [unpainted];
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({
      dir,
      engine,
      plane: () => plane,
      ...(opts.vision === undefined ? {} : { vision: opts.vision }),
    });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<Record<string, unknown>>;
        block(i: unknown, c: unknown): string | undefined;
      };
    return named;
  }

  it("holds a publish until the frame has been looked at", async () => {
    const named = await withEngine({ look: true });
    await named("frame.load").run({}, ctx("l1"));
    expect(named("frame.publish").block({}, ctx("l1"))).toContain("frame.look");
    await named("frame.look").run({}, ctx("l1"));
    expect(named("frame.publish").block({}, ctx("l1"))).toBeUndefined();
  });

  it("lets a run without eyes meet the same gate by being answered", async () => {
    const named = await withEngine({ look: true, vision: false });
    await named("frame.load").run({}, ctx("l2"));
    expect(named("frame.publish").block({}, ctx("l2"))).toContain("frame.look");
    expect(await named("frame.look").run({}, ctx("l2"))).toMatchObject({ available: false });
    expect(named("frame.publish").block({}, ctx("l2"))).toBeUndefined();
  });

  it("has no such gate where the engine cannot look", async () => {
    const named = await withEngine({});
    await named("frame.load").run({}, ctx("l3"));
    expect(named("frame.publish").block({}, ctx("l3"))).toBeUndefined();
  });

  it("keeps a change that paints a layer listed as unpainted, though no score moves", async () => {
    const named = await withEngine({ unpainted: true });
    await named("frame.load").run({}, ctx("u1"));
    const paint = {
      ...change([{ src: "root", props: { surface: "surface.root_background" } }]),
      surfaces: {
        root_background: { layers: [{ type: "gradient", ref: "gradient.prim_sec_horiz_1" }] },
      },
    };
    expect(await named("frame.override").run(paint, ctx("u1"))).toMatchObject({ kept: true });
  });

  it("still refuses a change that does nothing to a layer that was never listed", async () => {
    const named = await withEngine({ unpainted: true });
    await named("frame.load").run({}, ctx("u2"));
    const result = await named("frame.override").run(
      change([{ src: "somewhere-else", props: { surface: "surface.x" } }]),
      ctx("u2"),
    );
    expect(result).toMatchObject({ kept: false });
    expect(String(result.reason)).toContain("nothing measurable");
  });

  it("still refuses an unpainted layer's change that also does something else", async () => {
    const named = await withEngine({ unpainted: true });
    await named("frame.load").run({}, ctx("u3"));
    const result = await named("frame.override").run(
      change([{ src: "root", props: { surface: "surface.x", gap: "space.2" } }]),
      ctx("u3"),
    );
    expect(result).toMatchObject({ kept: false });
  });
});

describe("frame.publish", () => {
  it("waits until the worst findings have been examined", async () => {
    const finding = {
      nodeId: "n",
      src: "worst",
      type: "Box",
      mismatch: 500,
      off: 40,
      design: "#000000",
      render: "#ffffff",
      notes: [],
      conform: [],
    };
    const { engine, plane } = setup(() => measured(80));
    engine.firstPass = async (_b, start) => ({
      overrides: start,
      built: { tree: { nodes: [] }, cropped: [], addedTexts: [] } as unknown as Built,
      measurement: { ...measured(90), findings: [finding] },
    });
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({ dir, engine, plane: () => plane });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<unknown>;
        block(i: unknown, c: unknown): string | undefined;
      };
    await named("frame.load").run({}, ctx("g1"));
    expect(named("frame.publish").block({}, ctx("g1"))).toContain("worst");
    (bundle.byId as Map<string, unknown>).set("worst", { id: "worst", children: [] });
    await named("frame.node").run({ src: "worst" }, ctx("g1"));
    expect(named("frame.publish").block({}, ctx("g1"))).toBeUndefined();
  });

  it("stops holding a publish after two refusals, so a run always ends with a preview link", async () => {
    const finding = {
      nodeId: "n",
      src: "worst",
      type: "Box",
      mismatch: 500,
      off: 40,
      design: "#000000",
      render: "#ffffff",
      notes: [],
      conform: [],
    };
    const { engine, plane } = setup(() => measured(80));
    engine.firstPass = async (_b, start) => ({
      overrides: start,
      built: { tree: { nodes: [] }, cropped: [], addedTexts: [] } as unknown as Built,
      measurement: { ...measured(90), findings: [finding] },
    });
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({ dir, engine, plane: () => plane });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<unknown>;
        block(i: unknown, c: unknown): string | undefined;
        resolve(i: unknown, c: unknown): Record<string, unknown>;
      };
    await named("frame.load").run({}, ctx("g3"));
    expect(named("frame.publish").block({}, ctx("g3"))).toContain("1 of 2");
    expect(named("frame.publish").block({}, ctx("g3"))).toContain("2 of 2");
    // examined nothing, and it publishes anyway; the reviewer is shown what was left
    expect(named("frame.publish").block({}, ctx("g3"))).toBeUndefined();
    expect(named("frame.publish").resolve({}, ctx("g3")).unexamined).toEqual(["worst"]);
  });

  it("doesn't hold a publish for a crop, which has no cause to find", async () => {
    const finding = {
      nodeId: "n",
      src: "crop",
      type: "Image",
      mismatch: 5000,
      off: 40,
      design: "#000000",
      render: "#ffffff",
      notes: [],
      conform: [],
    };
    const { engine, plane } = setup(() => measured(80));
    engine.firstPass = async (_b, start) => ({
      overrides: start,
      built: { tree: { nodes: [] }, cropped: [], addedTexts: [] } as unknown as Built,
      measurement: { ...measured(90), findings: [finding] },
    });
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const list = createMatchTools({ dir, engine, plane: () => plane });
    const named = (name: string) =>
      list.find((tool) => tool.name === name) as unknown as {
        run(i: unknown, c: unknown): Promise<unknown>;
        block(i: unknown, c: unknown): string | undefined;
      };
    await named("frame.load").run({}, ctx("g2"));
    expect(named("frame.publish").block({}, ctx("g2"))).toBeUndefined();
  });

  it("shows the reviewer the measured numbers", async () => {
    const { named } = await tools(() => measured(80));
    await named("frame.load").run({}, ctx("p1"));
    expect(named("frame.publish").resolve({}, ctx("p1"))).toMatchObject({
      before: 80,
      match: 90,
      rawGradients: 1,
    });
  });

  it("stores the theme it extended, the surfaces and the tree, once", async () => {
    const { named, uploads } = await tools(() => measured(80));
    await named("frame.load").run({}, ctx("p2"));
    const first = await named("frame.publish").run({}, ctx("p2"));
    const again = await named("frame.publish").run({}, ctx("p2"));
    expect(uploads.map((upload) => upload.kind)).toEqual(["token_set", "surface_set", "dsl_tree"]);
    expect(first.previewUrl).toBe(
      "http://studio/v1/preview/dsl_tree-id?theme=token_set-id&surfaces=surface_set-id&width=100&bg=808080",
    );
    expect(again).toEqual(first);
  });

  it("survives a new process: the overrides are on disk", async () => {
    const { engine, plane } = setup(() => measured(80));
    const dir = await mkdtemp(join(tmpdir(), "card-match-"));
    const make = () => createMatchTools({ dir, engine, plane: () => plane });
    const load = make().find((tool) => tool.name === "frame.load") as unknown as {
      run(i: unknown, c: unknown): Promise<unknown>;
    };
    await load.run({}, ctx("p3"));
    const publish = make().find((tool) => tool.name === "frame.publish") as unknown as {
      resolve(i: unknown, c: unknown): Record<string, unknown>;
    };
    expect(publish.resolve({}, ctx("p3")).match).toBe(90);
  });
});

describe("an export with no screenshot that fits", () => {
  const unfit = () => ({
    ...measured(0),
    comparedPixels: 0,
    coverage: 0,
    plates: [{ name: "p.png", match: 0, scale: 0, problem: "too tall" }],
  });

  it("loads as unmeasured, can't be tuned, and can be published", async () => {
    const { named, uploads } = await tools(unfit);
    const loaded = await named("frame.load").run({}, ctx("u1"));
    expect(loaded).toMatchObject({ measured: false });
    expect(loaded.why).toContain("too tall");
    const tried = await named("frame.override").run(
      change([{ src: "s", props: { gap: "x" } }]),
      ctx("u1"),
    );
    expect(tried).toMatchObject({ kept: false });
    const shown = named("frame.publish").resolve({}, ctx("u1"));
    expect(shown).toMatchObject({ measured: false });
    expect(shown).not.toHaveProperty("match");
    const published = await named("frame.publish").run({}, ctx("u1"));
    expect(published).toMatchObject({ measured: false });
    expect(published).not.toHaveProperty("match");
    expect(published.previewUrl).toContain("http://studio/v1/preview/dsl_tree-id");
    expect(uploads.map((upload) => upload.kind)).toContain("dsl_tree");
  });

  it("is unmeasured too when a screenshot covers only a sliver", async () => {
    const { named } = await tools(() => ({ ...measured(45), coverage: 4.3 }));
    const loaded = await named("frame.load").run({}, ctx("u2"));
    expect(loaded).toMatchObject({ measured: false });
    expect(String(loaded.why)).toContain("4.3%");
  });

  it("must say why in the final", () => {
    const published = {
      previewUrl: "u",
      treeArtifactId: "t",
      measured: false,
      coverage: 0,
      estimated: false,
      unchecked: [],
      placeholderIcons: 0,
    };
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c", name: "frame.publish", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "c", content: JSON.stringify(published) },
    ];
    const final = { ...published, remaining: [], compilerFindings: [] };
    expect(verifyFinal(final, { messages })).toContain("unmeasuredBecause");
    expect(verifyFinal({ ...final, unmeasuredBecause: "too tall" }, { messages })).toBeUndefined();
  });
});

describe("verifyFinal", () => {
  const published = {
    previewUrl: "u",
    treeArtifactId: "t",
    measured: true,
    coverage: 100,
    estimated: false,
    unchecked: [],
    placeholderIcons: 0,
    before: 80,
    match: 90,
  };
  const messages: Message[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "frame.publish", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "c1", content: JSON.stringify(published) },
  ];
  const final = {
    ...published,
    remaining: ["Text 35:10234 is 15% off: glyph edges, no layout issue"],
    compilerFindings: [],
  };

  it("takes numbers frame.publish returned", () => {
    expect(verifyFinal(final, { messages })).toBeUndefined();
  });

  it("refuses a better number than was measured", () => {
    const refused = verifyFinal({ ...final, match: 100 }, { messages });
    expect(refused).toContain("match was 100, must be 90");
  });

  it("names every field that differs, and one that is missing", () => {
    const { before: _before, ...rest } = final;
    const refused = verifyFinal({ ...rest, match: 89.9 }, { messages });
    expect(refused).toContain("before was missing, must be 80");
    expect(refused).toContain("match was 89.9, must be 90");
  });

  it("completeFinal writes the published numbers over the model's", () => {
    const filled = completeFinal({ ...final, match: 89.9, coverage: 3 }, { messages });
    expect(filled).toEqual(final);
    expect(verifyFinal(filled, { messages })).toBeUndefined();
  });

  it("completeFinal leaves the output alone when nothing was published", () => {
    expect(completeFinal(final, { messages: [] })).toBe(final);
  });

  it("takes a list of unchecked layers retyped, if it is all there", () => {
    const listed = [
      messages[0] as Message,
      {
        role: "tool",
        toolCallId: "c1",
        content: JSON.stringify({ ...published, unchecked: ["Jofra Archer", "badge"] }),
      } as Message,
    ];
    const whole = { ...final, unchecked: ["Jofra  Archer", "badge"] };
    expect(verifyFinal(whole, { messages: listed })).toBeUndefined();
    expect(verifyFinal({ ...final, unchecked: ["badge"] }, { messages: listed })).toContain(
      "2 layers",
    );
  });

  it("refuses a remaining that only restates the score", () => {
    expect(verifyFinal({ ...final, remaining: ["The match is 90%."] }, { messages })).toContain(
      "not the score",
    );
  });

  it("refuses a low match with nothing said about the rest", () => {
    const low = [
      messages[0] as Message,
      {
        role: "tool",
        toolCallId: "c1",
        content: JSON.stringify({ ...published, match: 45 }),
      } as Message,
    ];
    expect(verifyFinal({ ...final, match: 45, remaining: [] }, { messages: low })).toContain("45%");
  });

  it("refuses a close match that claims nothing is left", () => {
    const close = [
      messages[0] as Message,
      {
        role: "tool",
        toolCallId: "c1",
        content: JSON.stringify({ ...published, match: 98.03 }),
      } as Message,
    ];
    expect(verifyFinal({ ...final, match: 98.03, remaining: [] }, { messages: close })).toContain(
      "something still differs",
    );
  });

  it("refuses a final with nothing published", () => {
    expect(verifyFinal(final, { messages: [] })).toContain("Nothing was published");
  });
});
