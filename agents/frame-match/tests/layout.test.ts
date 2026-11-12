/**
 * Layouts in a run: frame.load proposes what each container is and applies none of it. Every
 * carousel and tab bar, and anything else the frame cannot show, comes back as an open item
 * (evidence, candidates, a proposal, what memory holds), which the agent's model settles and
 * applies with frame.layout as ordinary input. No tool asks anyone, and frame.publish waits.
 */

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryRunState, type RunState } from "@dugout/contracts";
import { REPO_ROOT, toolDefinition } from "@dugout/core";
import { describe, expect, it } from "vitest";
import type { ControlPlane } from "../src/control-plane.ts";
import type { Built, Bundle, Measurement, Overrides } from "../src/frame.ts";
import {
  describeChoice,
  LayoutChoice,
  type LayoutIntent,
  type PlatformRead,
  withPlatform,
} from "../src/layout.ts";
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
  notes: [],
  themeArtifactId: "theme-1",
  themeRaw: { tokens: {} },
  doc: { rootNodeId: "1", root: { geometry: { bbox: { x: 0, y: 0, w: 1366, h: 412 } } } },
  byId: new Map(),
  plates: [{ nodeId: "1", name: "p", png: Buffer.alloc(0) }],
} as unknown as Bundle;

const carouselConfig = {
  slidesPerView: "auto" as const,
  slidesPerGroup: 1,
  centered: false,
  initialSlide: 0,
  loop: false,
  autoplay: false as const,
};

const players: LayoutIntent = {
  src: "35:10529",
  name: "Players",
  kind: "carousel",
  confidence: "certain",
  items: ["a", "b", "c", "d", "e"],
  evidence: ["5 matching items in one row", '1 of 5 items cut off by the edge of "Players"'],
  ask: [
    'How many items does "Players" hold in all?',
    'Should "Players" move on its own?',
    'After the last item, should "Players" wrap around?',
  ],
  choice: { src: "35:10529", kind: "carousel", config: carouselConfig },
  chrome: {},
};

const videos: LayoutIntent = {
  src: "35:4813",
  name: "Videos",
  kind: "row",
  confidence: "unsure",
  alternative: "carousel",
  items: ["v1", "v2", "v3", "v4"],
  evidence: ["4 matching items in one row", 'all 4 fit inside "container"; no arrows or dots'],
  ask: [
    'Is "Videos" a fixed row of 4, or a carousel that scrolls when there are more than 4? (proposed: a fixed row)',
  ],
  choice: { src: "35:4813", kind: "row" },
  chrome: {},
};

const latest: LayoutIntent = {
  src: "35:10439",
  name: "Latest",
  kind: "list",
  confidence: "likely",
  items: ["n1", "n2", "n3"],
  evidence: ["3 matching items in one column"],
  ask: [],
  choice: { src: "35:10439", kind: "list" },
  chrome: {},
};

/** `@fanos/dsl`'s build, as the agent loads it. */
const dsl = async () =>
  (await import(pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href)) as {
    fromPlatformCarousel(json: unknown, options: { colors?: ReadonlySet<string> }): PlatformRead;
  };

/** The platform's carousel config, as a CMS stores it. */
const PLATFORM = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/dsl/fixtures/platform/carousel.json"), "utf8"),
) as Record<string, unknown>;

/** The fixtures strip: centred on its second card, with designed back and next arrows. */
const fixtures: LayoutIntent = {
  src: "35:10545",
  name: "Fixtures",
  kind: "carousel",
  confidence: "certain",
  items: ["f1", "f2", "f3"],
  evidence: ["3 matching items in one row", "a designed previous and next arrow"],
  ask: ['Should "Fixtures" move on its own?'],
  choice: {
    src: "35:10545",
    kind: "carousel",
    config: { ...carouselConfig, centered: true, initialSlide: 1 },
  },
  chrome: { prev: "35:10567", next: "35:10578" },
};

/** A fake pipeline: carousels lower, and `score` says what the frame measures with them. */
function setup(intents: LayoutIntent[], score: (overrides: Overrides) => Measurement) {
  const built = (overrides: Overrides) =>
    ({
      tree: { schemaVersion: "1", nodes: [] },
      notes: [],
      themeRaw: {},
      surfaces: { assets: {}, surfaces: {} },
      cropped: [],
      addedTexts: [],
      errors: [],
      missing: [],
      layoutNotes: overrides.layouts.map((l) => ({
        src: l.src,
        message:
          l.kind === "carousel"
            ? "carousel of 5 slides"
            : `kept as compiled: a ${l.kind} is what the frame draws`,
        applied: l.kind === "carousel",
      })),
      overrides,
    }) as unknown as Built;
  const builds: Overrides[] = [];
  const engine: Engine = {
    bundle: async () => bundle,
    build: async (_b, overrides) => {
      builds.push(overrides);
      return built(overrides);
    },
    measure: async (_b, b) => score((b as unknown as { overrides: Overrides }).overrides),
    firstPass: async (_b, start) => ({
      overrides: start,
      built: built(start),
      measurement: measured(90),
    }),
    layouts: async () => structuredClone(intents),
    // eyes that read the frame as the IR does
    read: async () => ({
      experience: "",
      parts: [],
      layouts: structuredClone(intents),
      unsure: [],
      dropped: [],
      groups: [],
    }),
    // The real reader, from the built @fanos/dsl; colours are checked in its own tests.
    platform: async (json) => (await dsl()).fromPlatformCarousel(json, {}),
  };
  const plane = { upload: async (kind: string) => `${kind}-id` } as unknown as ControlPlane;
  return { engine, plane, builds };
}

// one state for each run, as the loop keeps it (ADR 0035)
const states = new Map<string, RunState>();
const stateOf = (runId: string) =>
  states.get(runId) ?? (states.set(runId, memoryRunState()).get(runId) as RunState);
const ctx = (runId: string) =>
  ({
    tenantId: "t",
    runId,
    signal: new AbortController().signal,
    state: stateOf(runId),
    input: { exportId: "6f1d2c1e-7a3b-4c7e-9a10-000000000001", project: "default" },
  }) as const;

type Memory = Parameters<typeof createMatchTools>[0] extends infer O
  ? O extends { decisions?: infer D }
    ? D
    : never
  : never;

async function tools(
  intents: LayoutIntent[],
  score: (o: Overrides) => Measurement = () => measured(90),
  decisions?: Memory,
) {
  const { engine, plane, builds } = setup(intents, score);
  const dir = await mkdtemp(join(tmpdir(), "frame-match-layout-"));
  const list = createMatchTools({
    dir,
    engine,
    plane: () => plane,
    web: "http://web",
    vision: false,
    read: async () => "",
    ...(decisions ? { decisions } : {}),
  });
  const named = (name: string) =>
    list.find((tool) => tool.name === name) as unknown as {
      run(input: unknown, c: ReturnType<typeof ctx>): Promise<Record<string, unknown>>;
      resolve(input: unknown, c: ReturnType<typeof ctx>): Record<string, unknown>;
      effect: string;
      block(input: unknown, c: ReturnType<typeof ctx>): string | undefined;
      input: { parse(v: unknown): unknown };
    };
  /** frame.layout with what the model decided: the choice, and who settled each open item. */
  const decide = async (
    choice: unknown,
    runId: string,
    settled: Array<{ id: string; by: "person" | "memory" | "agent" }> = [],
  ) => {
    const tool = named("frame.layout");
    return tool.run(tool.input.parse({ choice, settled }), ctx(runId));
  };
  return { named, decide, builds };
}

type Reported = {
  src: string;
  kind: string;
  applied: boolean;
  decided: boolean;
  note?: string;
};
const layoutsOf = (result: Record<string, unknown>) => result.layouts as Reported[];
type Open = {
  id: string;
  about: string;
  evidence: string;
  candidates?: Array<{ value: string; does: string }>;
  proposed?: string;
  canTake: string;
  before?: string;
};
/** What is open about the containers: the content item, open in every run until publishing, aside. */
const openOf = (result: Record<string, unknown>) =>
  ((result.open ?? []) as Open[]).filter((i) => i.id !== "content");

describe("frame.load", () => {
  it("proposes a carousel the frame shows and applies nothing: what it is is the agent's to settle", async () => {
    const { named, builds } = await tools([players, latest]);
    const loaded = await named("frame.load").run({}, ctx("l1"));
    expect(loaded.match).toBe(90);
    const [carousel, list] = layoutsOf(loaded);
    expect(carousel).toMatchObject({
      src: "35:10529",
      kind: "carousel",
      applied: false,
      decided: false,
    });
    // however sure the reading and the IR are, the kind is open, with how sure as evidence
    const kind = openOf(loaded).find((i) => i.id === "kind");
    expect(kind?.about).toContain("Players");
    expect(kind?.proposed).toBe("carousel");
    expect(kind?.evidence).toContain("Proposed carousel (certain)");
    // nothing lowered
    expect(builds.every((b) => b.layouts.length === 0)).toBe(true);
    // A list is what the compiler drew: nothing to apply and nothing to ask.
    expect(list).toMatchObject({ kind: "list", applied: true });
    expect(openOf(loaded).some((i) => i.about.includes("Latest"))).toBe(false);
  });

  it("reports what the frame cannot answer, the compiler's own question folded into the evidence", async () => {
    const { named } = await tools([videos, latest]);
    const loaded = await named("frame.load").run({}, ctx("l3"));
    const [row] = layoutsOf(loaded);
    expect(row).toMatchObject({ kind: "row", applied: true, decided: false });
    // the compiler's own open line is evidence, not a question put to anyone
    const open = openOf(loaded);
    expect(open.map((i) => i.id)).toEqual(["kind"]);
    expect(open[0]?.evidence).toContain("a fixed row of 4, or a carousel");
    expect(String(loaded.openRule)).toContain("`ask`");
  });

  it("reports whether the section shows data as an open item the agent settles at frame.publish", async () => {
    const { named } = await tools([players]);
    const loaded = await named("frame.load").run({}, ctx("l4"));
    const content = ((loaded.open ?? []) as Open[]).find((i) => i.id === "content");
    expect(content?.candidates?.map((c) => c.value)).toEqual(["none", "some"]);
    expect(content?.proposed).toBe("some");
    expect(content?.evidence).toContain('"Players" repeats 5 items as a carousel');
    expect(content?.canTake).toContain("frame.publish");
    expect((loaded.content as { note: string }).note).toContain("not settled");
  });
});

describe("when the frame cannot be read", () => {
  it("puts what the IR is sure of to the agent, and applies nothing unasked", async () => {
    const { engine, plane, builds } = setup([players], () => measured(90));
    const dir = await mkdtemp(join(tmpdir(), "frame-match-layout-"));
    const list = createMatchTools({
      dir,
      engine: {
        ...engine,
        read: async () => {
          throw new Error("vision is down");
        },
      },
      plane: () => plane,
      vision: false,
      read: async () => "",
    });
    const load = list.find((t) => t.name === "frame.load") as unknown as {
      run(i: unknown, c: unknown): Promise<Record<string, unknown>>;
    };
    const loaded = await load.run({}, ctx("u1"));
    expect(layoutsOf(loaded)[0]).toMatchObject({ kind: "carousel", applied: false });
    expect(openOf(loaded)[0]).toMatchObject({ id: "kind" });
    expect(openOf(loaded)[0]?.evidence).toContain("the frame was not read (vision is down)");
    expect((loaded.reading as { notBorneOut: string[] }).notBorneOut[0]).toContain(
      "vision is down",
    );
    // nothing lowered: the only builds are the plain ones
    expect(builds.every((b) => b.layouts.length === 0)).toBe(true);
  });
});

/** A design that is not cricket: a recipe site's rail of cards, certain from the frame. */
const recipes: LayoutIntent = {
  src: "7:100",
  name: "Weeknight recipes",
  kind: "carousel",
  confidence: "certain",
  items: ["r1", "r2", "r3", "r4"],
  evidence: [
    "4 matching items in one row",
    '1 of 4 items cut off by the edge of "Weeknight recipes"',
  ],
  ask: ['How many items does "Weeknight recipes" hold in all?'],
  choice: { src: "7:100", kind: "carousel", config: { ...carouselConfig, slidesPerView: 3 } },
  chrome: {},
};

describe("frame.layout", () => {
  it("reports a carousel's open items with evidence, candidates, a proposal and what it takes", async () => {
    const { named } = await tools([fixtures]);
    const loaded = await named("frame.load").run({}, ctx("q1"));
    expect(named("frame.layout").effect).toBe("read");
    const open = openOf(loaded);
    expect(open.map((i) => i.id)).toEqual(["kind", "items", "autoplay", "loop", "platform"]);
    const by = (id: string) => open.find((i) => i.id === id) as Open;
    expect(by("items")).toMatchObject({ proposed: "data" });
    expect(by("items").canTake).toContain("config.pages");
    expect(by("autoplay").proposed).toBe("off");
    expect(by("autoplay").candidates?.map((c) => c.value)).toEqual(["off", "3000", "5000", "8000"]);
    expect(by("autoplay").canTake).toContain("delayMs");
    expect(by("loop")).toMatchObject({ proposed: "no" });
    // the platform config is one the model may leave out: it proposes nothing
    expect(by("platform").proposed).toBeUndefined();
    expect(by("platform").canTake).toContain("config.platform");
    // each names its container and carries the frame's own evidence
    expect(by("loop").about).toContain(fixtures.name);
    expect(by("items").evidence).toContain("The frame shows 3");
  });

  it("reports the same for a design that is not cricket, from its own evidence", async () => {
    const { named } = await tools([recipes]);
    const open = openOf(await named("frame.load").run({}, ctx("q1r")));
    expect(open.map((i) => i.id)).toEqual(["kind", "items", "autoplay", "loop", "platform"]);
    expect(open[0]?.about).toContain("Weeknight recipes");
    expect(open[1]?.evidence).toContain("The frame shows 4");
  });

  it("reports what a row leaves open: what it is, with the frame's evidence and the detector's guess", async () => {
    const { named } = await tools([videos]);
    const open = openOf(await named("frame.load").run({}, ctx("q1b")));
    expect(open[0]).toMatchObject({ id: "kind", proposed: "row" });
    expect(open[0]?.evidence).toContain("all 4 fit inside");
    expect(open[0]?.candidates?.map((c) => c.value)).toEqual(["carousel", "row", "list"]);
    expect(open[0]?.canTake).toContain("grid");
    expect(open[0]?.evidence).toContain("The compiler asks:");
    expect(open).toHaveLength(1);
  });

  it("takes what the model decided as plain input, and what is open is gone once applied", async () => {
    const { named, decide } = await tools([videos]);
    await named("frame.load").run({}, ctx("q1c"));
    const result = await decide(videos.choice, "q1c");
    expect(openOf(result)).toEqual([]);
    expect(layoutsOf(result)[0]).toMatchObject({ decided: true });
  });

  it("applies the config as given: autoplay, loop and a page count", async () => {
    const { named, decide, builds } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("q1d"));
    const result = await decide(
      {
        ...fixtures.choice,
        config: {
          ...carouselConfig,
          centered: true,
          initialSlide: 1,
          autoplay: { delayMs: 4000 },
          loop: true,
          pages: 12,
        },
      },
      "q1d",
    );
    expect(result).toMatchObject({ kept: true, applied: true });
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toMatchObject({
      kind: "carousel",
      config: { autoplay: { delayMs: 4000 }, loop: true, pages: 12 },
    });
    // a config the choice schema refuses is not applied: no translating of words
    const refused = await decide(
      { ...fixtures.choice, config: { slidesPerView: "auto", autoplay: "every 4 seconds" } },
      "q1d",
    );
    expect(refused).toMatchObject({ kept: false });
    expect(refused.reason).toContain("config.autoplay");
  });

  it("takes the proposal for what a choice of the proposed kind leaves out", async () => {
    const { named, decide, builds } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("q1e"));
    await decide({ src: fixtures.src, kind: "carousel", config: { loop: true } }, "q1e");
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toMatchObject({
      config: { centered: true, initialSlide: 1, loop: true },
      chrome: fixtures.chrome,
    });
  });

  it("measures a decided carousel and reports the match before and after", async () => {
    const { named, decide } = await tools([players], (o) =>
      measured(o.layouts.length > 0 ? 88 : 90),
    );
    await named("frame.load").run({}, ctx("q1g"));
    const result = await decide(players.choice, "q1g");
    expect(result).toMatchObject({ kept: true, was: 90, match: 88 });
  });

  it("lets the model turn a carousel into a row, and needs a grid's own settings", async () => {
    const { named, decide, builds } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("q1f"));
    await decide({ src: fixtures.src, kind: "row" }, "q1f");
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toEqual({
      src: fixtures.src,
      kind: "row",
    });
    const grid = await decide({ src: fixtures.src, kind: "grid" }, "q1f");
    expect(grid).toMatchObject({ kept: false });
    expect(grid.reason).toContain("grid needs config { columns, rows }");
  });

  it("records who settled each open item, with the value read from the choice applied", async () => {
    const { named, decide } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("s1"));
    const result = await decide(
      {
        ...fixtures.choice,
        config: { ...carouselConfig, autoplay: { delayMs: 5000 }, loop: true, pages: 9 },
      },
      "s1",
      [
        { id: "autoplay", by: "person" },
        { id: "loop", by: "agent" },
        // no `before` for it: a claim of memory is the model's own decision
        { id: "items", by: "memory" },
      ],
    );
    expect(result.settled).toEqual([
      // what it is: left out, so the model's own
      { id: "kind", by: "agent", value: "35:10545: carousel" },
      { id: "items", by: "agent", value: "35:10545: 9" },
      { id: "autoplay", by: "person", value: "35:10545: 5000" },
      { id: "loop", by: "agent", value: "35:10545: yes" },
      // left out: the model's own
      { id: "platform", by: "agent", value: "35:10545: none" },
    ]);
  });

  it("settles an item from an active fact in memory, by memory, with no question", async () => {
    const memory: Memory = {
      decisionsOn: async () => [],
      decision: async () => undefined,
      fact: async (_t: string, key: string, status: string) =>
        key === "layout.carousel.autoplay" && status === "active"
          ? ({ value: "5000" } as never)
          : undefined,
    };
    const { named, decide } = await tools([recipes], undefined, memory);
    const open = openOf(await named("frame.load").run({}, ctx("m1")));
    const autoplay = open.find((i) => i.id === "autoplay");
    expect(autoplay?.before).toBe("the club's active fact layout.carousel.autoplay: 5000");
    expect(open.find((i) => i.id === "loop")?.before).toBeUndefined();
    // the model takes it from `before`: nothing asked (the tool cannot ask), recorded as memory
    const result = await decide(
      {
        ...recipes.choice,
        config: { ...(recipes.choice as { config: object }).config, autoplay: { delayMs: 5000 } },
      },
      "m1",
      [{ id: "autoplay", by: "memory" }],
    );
    expect(result.settled).toContainEqual({ id: "autoplay", by: "memory", value: "7:100: 5000" });
  });

  it("reads what a person decided on this section before, as `before`", async () => {
    const keys: string[] = [];
    const memory: Memory = {
      decisionsOn: async () => [],
      decision: async (_t: string, key: string) => {
        keys.push(key);
        return key.startsWith("frame-match:loop@") ? ({ value: true } as never) : undefined;
      },
    };
    const sectioned = { ...bundle, section: "sig-recipes" } as unknown as Bundle;
    const { engine, plane } = setup([recipes], () => measured(90));
    const dir = await mkdtemp(join(tmpdir(), "frame-match-layout-"));
    const list = createMatchTools({
      dir,
      engine: { ...engine, bundle: async () => sectioned },
      plane: () => plane,
      vision: false,
      decisions: memory,
    });
    const load = list.find((t) => t.name === "frame.load") as unknown as {
      run(i: unknown, c: unknown): Promise<Record<string, unknown>>;
    };
    const open = openOf(await load.run({}, ctx("m2")));
    expect(open.find((i) => i.id === "loop")?.before).toBe("decided on this section before: yes");
    expect(keys).toContain("frame-match:loop@sig-recipes");
  });

  it("applies the decision: a row that should scroll becomes a carousel that autoplays", async () => {
    const { named, decide } = await tools([videos]);
    await named("frame.load").run({}, ctx("q2"));
    const result = await decide(
      {
        src: "35:4813",
        kind: "carousel",
        config: { slidesPerView: "auto", autoplay: { delayMs: 5000 }, loop: true },
      },
      "q2",
    );
    expect(result).toMatchObject({ kept: true, applied: true, was: 90 });
    expect(result.layout).toBe(
      "carousel: slides keep their designed width; moves on its own every 5s; loops",
    );
    expect(layoutsOf(result)[0]).toMatchObject({ kind: "carousel", decided: true, applied: true });
  });

  it("refuses a container frame.load did not find", async () => {
    const { named, decide } = await tools([videos]);
    await named("frame.load").run({}, ctx("q3"));
    const result = await decide({ src: "9:9", kind: "row" }, "q3");
    expect(result).toMatchObject({ kept: false });
    expect(result.reason).toContain("35:4813");
  });

  it("is the only way to change a layout: frame.override does not take one", async () => {
    const { named } = await tools([videos]);
    const override = named("frame.override");
    expect(() => override.input.parse({ layouts: [{ src: "35:4813", kind: "row" }] })).toThrow();
  });
});

describe("frame.publish", () => {
  it("waits until every layout question has been asked, once", async () => {
    const { named, decide } = await tools([players, videos]);
    await named("frame.load").run({}, ctx("p1"));
    const block = () => named("frame.publish").block({}, ctx("p1"));
    expect(block()).toContain('"Players" (35:10529)');
    expect(block()).toContain('"Videos" (35:4813)');
    await decide(players.choice, "p1");
    expect(block()).not.toContain("Players");
    await decide(videos.choice, "p1");
    expect(block()).toBeUndefined();
  });

  it("publishes the tree with the decided layouts in it", async () => {
    const { named, decide, builds } = await tools([videos]);
    await named("frame.load").run({}, ctx("p2"));
    await decide({ src: "35:4813", kind: "carousel", config: { slidesPerView: "auto" } }, "p2");
    const said = { content: { data: "some", why: "a row of video cards" }, slots: [] };
    await named("frame.publish").run(named("frame.publish").resolve(said, ctx("p2")), ctx("p2"));
    expect(builds.at(-1)?.layouts).toEqual([
      {
        src: "35:4813",
        kind: "carousel",
        config: { ...carouselConfig },
        // the items frame.load found, kept where the model's choice leaves them out
        items: videos.items,
      },
    ]);
  });
});

describe("the choice, as a person reads it", () => {
  it("says a carousel in plain words", () => {
    expect(
      describeChoice({
        src: "x",
        kind: "carousel",
        config: {
          ...carouselConfig,
          centered: true,
          initialSlide: 1,
          pages: 4,
          controls: {
            arrows: { placement: "edges", states: { disabled: { opacity: "opacity.40" } } },
          },
          props: { effect: { kind: "creative" } },
        },
      }),
    ).toBe(
      "carousel: slides keep their designed width; centred, starting on slide 2; 4 pages; no autoplay; no loop; arrows at the edges; arrows disabled look set; creative effect",
    );
    expect(
      describeChoice({ src: "x", kind: "tabs", config: { options: ["A", "B"], active: 1 } }),
    ).toBe('tabs "A", "B", "B" selected');
  });
});

describe("the choice schema", () => {
  it("accepts and rejects what @fanos/dsl's does", async () => {
    const dsl = (await import(
      pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
    )) as {
      layoutChoiceSchema: { safeParse(v: unknown): { success: boolean; data?: unknown } };
    };
    const samples: unknown[] = [
      { src: "a", kind: "row" },
      { src: "a", kind: "list" },
      { src: "a", kind: "carousel", config: { slidesPerView: "auto" } },
      {
        src: "a",
        kind: "carousel",
        config: {
          slidesPerView: 2.5,
          loop: true,
          autoplay: { delayMs: 5000 },
          controls: {
            arrows: { placement: "edges", states: { disabled: { opacity: "opacity.40" } } },
            pagination: { states: { active: { fill: "color.x" } } },
          },
          props: { effect: "fade" },
        },
      },
      {
        src: "a",
        kind: "carousel",
        config: { slidesPerView: 3, centered: true, initialSlide: 1, pages: 4 },
      },
      { src: "a", kind: "grid", config: { columns: 3, rows: 2 } },
      { src: "a", kind: "tabs", config: { options: ["A", "B"], active: 0 } },
      // refused by both
      { src: "a", kind: "carousel", config: { slidesPerView: 0 } },
      { src: "a", kind: "carousel", config: { slidesPerView: "auto", autoplay: true } },
      { src: "a", kind: "carousel", config: { slidesPerView: "auto", controls: ["arrows"] } },
      {
        src: "a",
        kind: "carousel",
        config: { slidesPerView: "auto", controls: { arrows: { placement: "middle" } } },
      },
      { src: "a", kind: "carousel", config: { slidesPerView: "auto", controls: { thumbs: {} } } },
      { src: "a", kind: "row", config: {} },
      { src: "a", kind: "marquee" },
    ];
    for (const sample of samples) {
      const theirs = dsl.layoutChoiceSchema.safeParse(sample);
      const ours = LayoutChoice.safeParse(sample);
      expect(ours.success, JSON.stringify(sample)).toBe(theirs.success);
      if (ours.success) expect(ours.data).toEqual(theirs.data);
    }
  });
});

describe("the agent's tools", () => {
  it("each has an object input, so the model's tool list can be built", () => {
    const list = createMatchTools({ dir: tmpdir(), vision: false });
    for (const tool of list) {
      const { parameters } = toolDefinition(tool.name, tool.description, tool.input);
      // Bedrock refuses `oneOf` anywhere in a tool's schema.
      expect(JSON.stringify(parameters), tool.name).not.toContain('"oneOf"');
    }
  });
});

describe("a platform carousel config", () => {
  const proposal = fixtures.choice as Extract<LayoutChoice, { kind: "carousel" }>;

  it("fills what the frame cannot show, and leaves what it shows to the design", async () => {
    const read = (await dsl()).fromPlatformCarousel(PLATFORM, {
      colors: new Set([
        "button_outline_style_3_text_default",
        "text_invert_high",
        "core_neu_50",
        "text_main_prim",
      ]),
    });
    const { choice, notes, conflicts } = withPlatform(proposal, read, {
      arrows: true,
      indicator: false,
    });
    expect(choice.config).toMatchObject({
      // the frame's, where the config says nothing
      initialSlide: 1,
      // the config's, a person's word, where the frame shows otherwise too
      slidesPerView: 1,
      centered: false,
      loop: false,
      autoplay: { delayMs: 3000 },
      // the design drew the arrows: at the edges (position center), and no disabled colours the
      // theme has, so they fade as lowering does by default
      controls: { arrows: { placement: "edges" } },
    });
    // Nothing about a look is a Carousel prop.
    expect(choice.config.props).toEqual({ freeMode: false });
    expect(notes.join("\n")).toContain('"color_nue_700" is not a colour in this theme');
    expect(notes.join("\n")).toContain("they fade when there is nowhere to go");
    // What the design did not draw, a variant cannot draw: said.
    expect(notes.join("\n")).toContain(
      "the config shows a counter (variant 1), but the design draws none",
    );
    expect(notes.join("\n")).toContain("autoplay progress bar, but the design draws none");
    // where the two disagree it is reported, never dropped
    expect(conflicts).toContainEqual({
      field: "slides_per_view",
      config: 1,
      frame: "each slide at its designed width",
      applied: "config",
    });
    expect(conflicts.find((c) => c.field === "centered_slides")).toMatchObject({
      config: false,
      applied: "config",
    });
    expect(notes.join("\n")).toContain("the design draws its arrows, so they keep their look");
  });

  it("is applied by frame.layout from the JSON the reviewer pasted, as text or as an object", async () => {
    for (const platform of [PLATFORM, JSON.stringify(PLATFORM)]) {
      const { named, decide, builds } = await tools([fixtures]);
      await named("frame.load").run({}, ctx("pl"));
      const result = await decide({ ...proposal, config: { ...proposal.config, platform } }, "pl");
      expect(result).toMatchObject({ kept: true });
      expect(result.platformConflicts).toContainEqual(
        expect.objectContaining({ field: "slides_per_view", applied: "config" }),
      );
      const applied = builds.at(-1)?.layouts.find((l) => l.src === fixtures.src);
      expect(applied).toMatchObject({
        kind: "carousel",
        config: { autoplay: { delayMs: 3000 }, controls: { arrows: { placement: "edges" } } },
      });
    }
  });

  it("is offered as an open item, and applied from the JSON the model passes, reporting what it sets", async () => {
    const { named, decide, builds } = await tools([fixtures]);
    const loaded = await named("frame.load").run({}, ctx("pc"));
    expect(openOf(loaded).some((i) => i.id === "platform")).toBe(true);
    const result = await decide(
      { ...proposal, config: { ...proposal.config, platform: JSON.stringify(PLATFORM) } },
      "pc",
      [{ id: "platform", by: "person" }],
    );
    const text = (result.platformSets as string[]).join("\n");
    expect(text).toContain("From the platform config: autoplay every 3s; no loop;");
    expect(text).toContain(
      "Applied from the config where the frame shows otherwise: slides_per_view, centered_slides.",
    );
    expect(text).toContain(
      "Drawn by the tree, so reported where they differ from the frame: space_between, direction.",
    );
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toMatchObject({
      config: { autoplay: { delayMs: 3000 } },
    });
    expect(result.settled).toContainEqual({
      id: "platform",
      by: "person",
      value: "35:10545: applied",
    });
    // JSON that is not JSON is refused with the schema's message, and nothing is applied from it
    const before = builds.length;
    const refused = await decide(
      { ...proposal, config: { ...proposal.config, platform: "slides_per_view: 1" } },
      "pc",
    );
    expect(refused).toMatchObject({ kept: false });
    expect(refused.reason).toContain("config.platform is not a JSON object");
    expect(builds.length).toBe(before);
  });

  it("is refused for anything but a carousel", async () => {
    const { named, decide } = await tools([videos]);
    await named("frame.load").run({}, ctx("pr"));
    const result = await decide(
      { src: videos.src, kind: "row", config: { platform: PLATFORM } },
      "pr",
    );
    expect(result).toMatchObject({ kept: false });
    expect(result.reason).toContain("applies to a carousel");
  });
});
