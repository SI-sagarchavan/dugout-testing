/**
 * Layouts in a run: a carousel the frame shows is applied without a question, as long as the
 * first paint holds; anything the frame cannot show is asked of a person through frame.layout,
 * and frame.publish waits for it.
 */

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Answers, AwaitingAnswers } from "@dugout/contracts";
import { REPO_ROOT, toolDefinition } from "@dugout/core";
import { describe, expect, it } from "vitest";
import type { ControlPlane } from "../src/control-plane.ts";
import type { Built, Bundle, Measurement, Overrides } from "../src/frame.ts";
import {
  describeChoice,
  LayoutChoice,
  type LayoutIntent,
  type LayoutJudge,
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
    // The real reader, from the built @fanos/dsl; colours are checked in its own tests.
    platform: async (json) => (await dsl()).fromPlatformCarousel(json, {}),
  };
  const plane = { upload: async (kind: string) => `${kind}-id` } as unknown as ControlPlane;
  return { engine, plane, builds };
}

const ctx = (runId: string, answered?: { by: string; answers: Answers }) =>
  ({
    tenantId: "t",
    runId,
    signal: new AbortController().signal,
    input: { exportId: "6f1d2c1e-7a3b-4c7e-9a10-000000000001", project: "default" },
    ...(answered ? { answered } : {}),
  }) as const;

async function tools(
  intents: LayoutIntent[],
  score: (o: Overrides) => Measurement = () => measured(90),
  judge: LayoutJudge | false = false,
) {
  const { engine, plane, builds } = setup(intents, score);
  const dir = await mkdtemp(join(tmpdir(), "frame-match-layout-"));
  const list = createMatchTools({
    dir,
    engine,
    plane: () => plane,
    web: "http://web",
    vision: false,
    judge,
  });
  const named = (name: string) =>
    list.find((tool) => tool.name === name) as unknown as {
      run(input: unknown, c: ReturnType<typeof ctx>): Promise<Record<string, unknown>>;
      resolve(input: unknown, c: ReturnType<typeof ctx>): Record<string, unknown>;
      effect: string;
      block(input: unknown, c: ReturnType<typeof ctx>): string | undefined;
      input: { parse(v: unknown): unknown };
    };
  /** frame.layout once a person has answered: with `answers`, applied to the choice as proposed. */
  const decide = async (choice: unknown, runId: string, answers: Answers = {}) => {
    const tool = named("frame.layout");
    return tool.run(tool.input.parse({ choice }), ctx(runId, { by: "sagar", answers }));
  };
  /** What frame.layout asks, with nobody to answer yet. */
  const asking = async (choice: unknown, runId: string) => {
    const tool = named("frame.layout");
    try {
      await tool.run(tool.input.parse({ choice }), ctx(runId));
    } catch (err) {
      if (err instanceof AwaitingAnswers) return err.questions;
      throw err;
    }
    return undefined;
  };
  return { named, decide, asking, builds };
}

type Reported = {
  src: string;
  kind: string;
  applied: boolean;
  decided: boolean;
  ask?: string[];
  note?: string;
};
const layoutsOf = (result: Record<string, unknown>) => result.layouts as Reported[];

describe("frame.load", () => {
  it("applies a carousel the frame shows, when the first paint holds", async () => {
    const { named } = await tools([players, latest]);
    const loaded = await named("frame.load").run({}, ctx("l1"));
    expect(loaded.match).toBe(90);
    const [carousel, list] = layoutsOf(loaded);
    expect(carousel).toMatchObject({
      src: "35:10529",
      kind: "carousel",
      applied: true,
      decided: false,
    });
    // A list is what the compiler drew: nothing to apply and nothing to ask.
    expect(list).toMatchObject({ kind: "list", applied: true });
    expect(list).not.toHaveProperty("ask");
  });

  it("leaves a carousel out when lowering moves the first paint, and says why", async () => {
    const { named } = await tools([players], (o) => measured(o.layouts.length > 0 ? 88 : 90));
    const loaded = await named("frame.load").run({}, ctx("l2"));
    expect(loaded.match).toBe(90);
    const [carousel] = layoutsOf(loaded);
    expect(carousel?.applied).toBe(false);
    expect(carousel?.note).toContain("first paint moved (match 90 → 88");
  });

  it("asks only what the frame cannot answer, and explains how", async () => {
    const { named } = await tools([videos, latest]);
    const loaded = await named("frame.load").run({}, ctx("l3"));
    const [row] = layoutsOf(loaded);
    expect(row).toMatchObject({ kind: "row", applied: true, decided: false });
    expect(row?.ask?.[0]).toMatch(/fixed row of 4, or a carousel/);
    expect(loaded.layoutNote).toContain("frame.layout");
  });
});

/** A doubtful row: the detector scored it 0.55 as a row, with a carousel as the other reading. */
const squad: LayoutIntent = {
  ...videos,
  src: "35:20000",
  name: "Squad",
  score: 0.55,
  context: ['layer "Squad" inside "Players"', "5 items of 285x420px, gaps 24px"],
  alternativeChoice: {
    src: "35:20000",
    kind: "carousel",
    config: {
      slidesPerView: "auto",
      slidesPerGroup: 1,
      centered: false,
      initialSlide: 0,
      loop: false,
      autoplay: false,
    },
  },
  alternativeAsk: ['How many items does "Squad" hold in all? (proposed: whatever the data holds)'],
  choice: { src: "35:20000", kind: "row" },
};

describe("layout judge", () => {
  it("lets a sure model verdict make a doubtful row a carousel, with the context in the question", async () => {
    const seen: string[] = [];
    const judge: LayoutJudge = async (prompt) => {
      seen.push(prompt);
      return 'Sure: {"kind":"carousel","confidence":0.9,"reason":"a player roster"}';
    };
    const { named } = await tools([squad], undefined, judge);
    const loaded = await named("frame.load").run({}, ctx("j1"));
    const [layout] = layoutsOf(loaded);
    expect(layout).toMatchObject({
      kind: "carousel",
      confidence: "certain",
      score: 0.9,
      applied: true,
    });
    expect(seen[0]).toContain("5 items of 285x420px");
    expect(seen[0]).toContain("score 0.55");
  });

  it("leaves a doubtful row to a person when the model is not sure either", async () => {
    const judge: LayoutJudge = async () => '{"kind":"carousel","confidence":0.5,"reason":"maybe"}';
    const { named } = await tools([squad], undefined, judge);
    const [layout] = layoutsOf(await named("frame.load").run({}, ctx("j2")));
    expect(layout).toMatchObject({ kind: "row", confidence: "unsure", score: 0.55 });
    expect(layout?.ask).toHaveLength(1);
  });

  it("falls back to the detector when the model fails", async () => {
    const judge: LayoutJudge = async () => {
      throw new Error("down");
    };
    const { named } = await tools([squad], undefined, judge);
    const [layout] = layoutsOf(await named("frame.load").run({}, ctx("j3")));
    expect(layout).toMatchObject({ kind: "row", confidence: "unsure" });
  });

  it("does not ask a model about a layout the detector is sure of", async () => {
    let asked = 0;
    const judge: LayoutJudge = async () => {
      asked++;
      return "{}";
    };
    const { named } = await tools([players], undefined, judge);
    await named("frame.load").run({}, ctx("j4"));
    expect(asked).toBe(0);
  });
});

describe("frame.layout", () => {
  it("stops the run with questions written from what the frame showed, each with its proposal", async () => {
    const { named, asking } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("q1"));
    expect(named("frame.layout").effect).toBe("read");
    const questions = await asking(fixtures.choice, "q1");
    expect(questions?.map((q) => q.id)).toEqual(["items", "autoplay", "loop", "platform"]);
    const by = (id: string) => questions?.find((q) => q.id === id);
    expect(by("items")).toMatchObject({ kind: "choice", allowOther: true, proposed: ["data"] });
    expect(by("autoplay")).toMatchObject({ kind: "choice", proposed: ["off"] });
    expect(by("autoplay")?.options.map((o) => o.value)).toEqual(["off", "3000", "5000", "8000"]);
    expect(by("loop")).toMatchObject({ kind: "confirm", proposed: ["no"] });
    // the platform question is one a person may skip: it proposes nothing
    expect(by("platform")).toMatchObject({ kind: "text", proposed: [] });
    // every question carries the frame's own evidence, not a generic prompt
    expect(by("loop")?.question).toContain(fixtures.name);
    expect(by("items")?.why).toContain("The frame shows");
  });

  it("asks what the frame leaves open about a row: what it is, with the frame's evidence", async () => {
    const { named, asking } = await tools([videos]);
    await named("frame.load").run({}, ctx("q1b"));
    const questions = await asking(videos.choice, "q1b");
    // the frame is not sure what it is, so that is the first question, with the compiler's guess
    expect(questions?.[0]).toMatchObject({ id: "kind", kind: "choice", proposed: ["row"] });
    expect(questions?.[0]?.why).toContain("all 4 fit inside");
    expect(questions?.[1]).toMatchObject({ id: "ask_1", kind: "text" });
    expect(questions?.[1]?.question).toContain("fixed row of 4, or a carousel");
  });

  it("asks nothing, and applies the proposal, for a layout already decided", async () => {
    const { named, decide, asking } = await tools([videos]);
    await named("frame.load").run({}, ctx("q1c"));
    await decide(videos.choice, "q1c");
    expect(await asking(videos.choice, "q1c")).toBeUndefined();
  });

  it("puts each answer into the proposal: autoplay, loop, a page count, and what it could not read", async () => {
    const { named, decide, builds } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("q1d"));
    const result = await decide(fixtures.choice, "q1d", {
      autoplay: "every 4 seconds",
      loop: true,
      items: "12",
    });
    expect(result).toMatchObject({ kept: true, applied: true });
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toMatchObject({
      kind: "carousel",
      config: { autoplay: { delayMs: 4000 }, loop: true, pages: 12 },
    });
    // words that are not a time leave the proposal, and the call says so
    const second = await tools([fixtures]);
    await second.named("frame.load").run({}, ctx("q1e"));
    const unclear = await second.decide(fixtures.choice, "q1e", {
      autoplay: "sometimes",
      items: "lots",
    });
    expect((unclear.answers as string[]).join("\n")).toContain(
      'autoplay "sometimes" was not a time',
    );
    expect((unclear.answers as string[]).join("\n")).toContain('items "lots" was not a number');
  });

  it("lets a person turn a carousel into a row, and keeps what it cannot make from words", async () => {
    const { named, decide, builds } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("q1f"));
    await decide(fixtures.choice, "q1f", { kind: "row" });
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toEqual({
      src: fixtures.src,
      kind: "row",
    });
    const grid = await tools([fixtures]);
    await grid.named("frame.load").run({}, ctx("q1g"));
    const result = await grid.decide(fixtures.choice, "q1g", { kind: "grid" });
    expect((result.answers as string[]).join("\n")).toContain("grid needs its own settings");
  });

  it("applies the answer: a row that should scroll becomes a carousel that autoplays", async () => {
    const { named, decide } = await tools([videos]);
    await named("frame.load").run({}, ctx("q2"));
    const result = await decide(
      {
        src: "35:4813",
        kind: "carousel",
        config: { slidesPerView: "auto", autoplay: { delayMs: 5000 }, loop: true },
      },
      ctx("q2").runId,
    );
    expect(result).toMatchObject({ kept: true, applied: true, was: 90 });
    expect(result.layout).toBe(
      "carousel: slides keep their designed width; moves on its own every 5s; loops",
    );
    expect(layoutsOf(result)[0]).toMatchObject({ kind: "carousel", decided: true, applied: true });
    expect(layoutsOf(result)[0]).not.toHaveProperty("ask");
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
    await named("frame.publish").run(named("frame.publish").resolve({}, ctx("p2")), ctx("p2"));
    expect(builds.at(-1)?.layouts).toEqual([
      { src: "35:4813", kind: "carousel", config: { ...carouselConfig } },
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
    const { choice, notes } = withPlatform(proposal, read, { arrows: true, indicator: false });
    expect(choice.config).toMatchObject({
      // the frame's
      slidesPerView: "auto",
      centered: true,
      initialSlide: 1,
      // the config's
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
    expect(notes.join("\n")).toContain(
      "slides_per_view 1 left out: the frame shows each slide at its designed width",
    );
    expect(notes.join("\n")).toContain("centered_slides false left out");
    expect(notes.join("\n")).toContain("the design draws its arrows, so they keep their look");
  });

  it("is applied by frame.layout from the JSON the reviewer pasted, as text or as an object", async () => {
    for (const platform of [PLATFORM, JSON.stringify(PLATFORM)]) {
      const { named, decide, builds } = await tools([fixtures]);
      await named("frame.load").run({}, ctx("pl"));
      const result = await decide({ ...proposal, config: { ...proposal.config, platform } }, "pl");
      expect(result).toMatchObject({ kept: true });
      expect((result.platform as string[]).join("\n")).toContain("slides_per_view 1 left out");
      const applied = builds.at(-1)?.layouts.find((l) => l.src === fixtures.src);
      expect(applied).toMatchObject({
        kind: "carousel",
        config: { autoplay: { delayMs: 3000 }, controls: { arrows: { placement: "edges" } } },
      });
    }
  });

  it("is applied from the JSON a person gave as their answer, and reports what it sets", async () => {
    const { named, decide, asking, builds } = await tools([fixtures]);
    await named("frame.load").run({}, ctx("pc"));
    expect((await asking(fixtures.choice, "pc"))?.some((q) => q.id === "platform")).toBe(true);
    const result = await decide(fixtures.choice, "pc", { platform: JSON.stringify(PLATFORM) });
    const text = (result.platformSets as string[]).join("\n");
    expect(text).toContain("From the platform config: autoplay every 3s; no loop;");
    expect(text).toContain(
      "Left to the frame, which shows them: slides_per_view, centered_slides, space_between, direction.",
    );
    expect(builds.at(-1)?.layouts.find((l) => l.src === fixtures.src)).toMatchObject({
      config: { autoplay: { delayMs: 3000 } },
    });
    // JSON that is not JSON is said, and nothing is applied from it
    const bad = await tools([fixtures]);
    await bad.named("frame.load").run({}, ctx("pd"));
    const notJson = await bad.decide(fixtures.choice, "pd", { platform: "slides_per_view: 1" });
    expect((notJson.answers as string[]).join("\n")).toContain("the platform config was not JSON");
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
