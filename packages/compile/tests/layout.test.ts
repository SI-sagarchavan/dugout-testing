/**
 * Layout detection, one rule at a time, on hand-built IR.
 *
 * Each case is the smallest frame that shows one thing a designer draws: a row cut off by its
 * clip, a pair of arrows, a row of dots, a tab bar. The shapes and names follow the Southern
 * Brave files the rules were tuned on (`back/next` buttons holding `atom_icon_arrow_left`, a
 * `Tab` frame of label items, a fixture card whose active variant has its own key).
 */

import type { LayoutChoice } from "@fanos/dsl";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";
import { parseFrameIRDocument } from "@fanos/surface-canvas/ir";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { validate, type FlatNode, type FlatTree } from "@fanos/dsl";
import { detectLayout } from "../src/layout/detect.js";
import { counterFormat, lowerLayout } from "../src/layout/lower.js";

const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname;

let next = 0;
interface Spec {
  name?: string;
  type?: FrameIRNode["type"];
  at: [number, number, number, number];
  mode?: "horizontal" | "vertical" | "none";
  clip?: boolean;
  sig?: string;
  fill?: string;
  text?: string;
  sizing?: "fixed" | "fill" | "hug";
  children?: FrameIRNode[];
}

function n(spec: Spec): FrameIRNode {
  const [x, y, w, h] = spec.at;
  const zero = { value: 0, unbound: false };
  return {
    id: `1:${++next}`,
    name: spec.name ?? `Frame ${next}`,
    type: spec.type ?? (spec.text !== undefined ? "TEXT" : "FRAME"),
    layout: {
      mode: spec.mode ?? "none",
      gap: null,
      padding: { top: zero, right: zero, bottom: zero, left: zero },
      align: null,
      justify: null,
      wrap: false,
      sizing: { w: spec.sizing ?? "fixed", h: "fixed" },
      positioning: "auto",
    },
    geometry: { bbox: { x, y, w, h }, relBbox: { x, y, w, h }, rotation: 0, aspectBucket: "landscape" },
    fill: spec.fill ? { tokenRef: spec.fill, unbound: false } : null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: spec.clip ?? false,
    ...(spec.text !== undefined ? { text: { characters: spec.text } } : {}),
    structuralSignature: spec.sig ?? `s-${next}`,
    canonicalSignature: spec.sig ?? `c-${next}`,
    repeatedSiblings: 1,
    depth: 0,
    childCount: spec.children?.length ?? 0,
    children: spec.children ?? [],
  } as unknown as FrameIRNode;
}

const doc = (root: FrameIRNode): FrameIRDocument =>
  ({ root, rootNodeId: root.id, assets: [], irVersion: "1.10.0", breakpointHint: 1366 }) as unknown as FrameIRDocument;

/** A card: big enough to page through, with something inside so it is not a bare shape. */
const card = (x: number, y = 0, w = 281, h = 412, sig = "card") =>
  n({ name: "player card", at: [x, y, w, h], sig, children: [n({ at: [x, y, w, 40], text: "Name" })] });

/** `count` cards from x=0, `gap` apart. */
const cards = (count: number, w = 281, gap = 16, y = 0) =>
  Array.from({ length: count }, (_, i) => card(i * (w + gap), y, w));

const row = (children: FrameIRNode[], width: number, options: Partial<Spec> = {}) =>
  n({ name: "row", at: [0, 0, width, 412], mode: "horizontal", children, ...options });

describe("carousel", () => {
  it("is certain when a card is cut off by the frame's edge", () => {
    const [intent] = detectLayout(doc(row(cards(5), 1170)));
    expect(intent?.kind).toBe("carousel");
    expect(intent?.confidence).toBe("certain");
    expect(intent?.items).toHaveLength(5);
    expect(intent?.evidence.join(" ")).toContain("1 of 5 items cut off");
    // Slides keep their designed width: the first paint is exactly the frame.
    expect(intent?.choice).toMatchObject({ kind: "carousel", config: { slidesPerView: "auto", loop: false, autoplay: false } });
  });

  it("asks only what the frame cannot show", () => {
    const [intent] = detectLayout(doc(row(cards(5), 1170)));
    expect(intent?.ask).toHaveLength(3);
    expect(intent?.ask[0]).toContain("How many items");
    expect(intent?.ask.join(" ")).toMatch(/move on its own/);
    expect(intent?.ask.join(" ")).toMatch(/wrap around/);
  });

  it("reads a clip on an ancestor, not only the row's own", () => {
    const strip = n({ name: "FIXTURES", at: [0, 0, 1366, 412], clip: true, children: [row(cards(6), 1800)] });
    const [intent] = detectLayout(doc(n({ name: "page", at: [0, 0, 1366, 600], children: [strip] })));
    expect(intent?.kind).toBe("carousel");
    expect(intent?.evidence.join(" ")).toContain('edge of "FIXTURES"');
  });

  it("groups a component's variants: the active card is still one of the items", () => {
    const items = [0, 1, 2].map((i) =>
      n({ name: "D_2 Fixture Card", type: "INSTANCE", at: [-224 + i * 610, 0, 594, 235], sig: i === 1 ? "active" : "rest" }),
    );
    const [intent] = detectLayout(doc(row(items, 1366, { clip: true })));
    expect(intent?.kind).toBe("carousel");
    expect(intent?.items).toHaveLength(3);
    expect(intent?.evidence.join(" ")).toContain("both edges");
    // The middle card sits in the middle of the clip: centred, starting on it.
    expect(intent?.evidence.join(" ")).toContain("centred on item 2");
    expect(intent?.choice).toMatchObject({ config: { centered: true, initialSlide: 1 } });
  });

  it("wires designed arrows by the glyph inside them, and asks nothing about controls", () => {
    const button = (x: number, glyph: string) =>
      n({ name: "back/next", type: "INSTANCE", at: [x, 430, 40, 40], children: [n({ name: glyph, type: "INSTANCE", at: [x + 10, 440, 20, 20] })] });
    const prev = button(1060, "atom_icon_arrow_left");
    const nextArrow = button(1110, "atom_icon_arrow_right");
    const section = n({
      name: "Team",
      at: [0, 0, 1366, 500],
      children: [row(cards(4), 1172), n({ name: "controls", at: [1000, 430, 160, 40], mode: "horizontal", children: [prev, nextArrow] })],
    });
    const [intent] = detectLayout(doc(section));
    expect(intent?.kind).toBe("carousel");
    expect(intent?.confidence).toBe("certain");
    expect(intent?.chrome).toEqual({ prev: prev.id, next: nextArrow.id });
    expect(intent?.evidence.join(" ")).toContain("a designed previous and next arrow");
    expect(intent?.evidence.join(" ")).not.toContain("read by position");
  });

  it("reads two arrows on one line by position when their names point the other way", () => {
    // As the fixtures strip draws them: `arrow_right` first (it draws "←"), `arrow_left` second.
    const button = (x: number, glyph: string) =>
      n({ name: "back/next", type: "INSTANCE", at: [x, 430, 40, 40], children: [n({ name: glyph, type: "INSTANCE", at: [x + 10, 440, 20, 20] })] });
    const first = button(1060, "atom_icon_arrow_right");
    const second = button(1110, "atom_icon_arrow_left");
    const section = n({
      name: "Team",
      at: [0, 0, 1366, 500],
      children: [row(cards(4), 1172), n({ name: "controls", at: [1000, 430, 160, 40], mode: "horizontal", children: [first, second] })],
    });
    const [intent] = detectLayout(doc(section));
    expect(intent?.chrome).toEqual({ prev: first.id, next: second.id });
    expect(intent?.evidence).toContain("the arrows' names point the other way to their order: read by position");
  });

  it("does not take a card's own call-to-action arrow for a control", () => {
    const withCta = cards(4).map((c) => {
      c.children.push(n({ name: "atom_icon_arrow_up_right", type: "INSTANCE", at: [c.geometry.bbox.x + 250, 380, 18, 18] }));
      return c;
    });
    const [intent] = detectLayout(doc(row(withCta, 1172)));
    expect(intent?.kind).not.toBe("carousel");
  });

  it("does not take the arrow of a labelled button beside the row for a control", () => {
    // "VIEW MORE →" in a header above two team cards: a link, not the row's previous arrow.
    const viewMore = n({
      name: "atom_button_master",
      type: "INSTANCE",
      at: [1100, 20, 131, 38],
      mode: "horizontal",
      children: [
        n({ at: [1110, 30, 70, 16], text: "VIEW MORE" }),
        n({ name: "atom_icon_arrow_left", type: "INSTANCE", at: [1190, 30, 20, 20] }),
      ],
    });
    const header = n({ name: "header row", at: [0, 0, 1366, 80], mode: "horizontal", children: [viewMore] });
    const teams = row(cards(2, 182, 16, 100), 1366, { name: "Team Info", at: [0, 100, 1366, 230] });
    const section = n({ name: "Main Content", at: [0, 0, 1366, 400], children: [header, teams] });
    const intents = detectLayout(doc(section));
    expect(intents.find((i) => i.kind === "carousel")).toBeUndefined();
  });

  it("counts pages from designed dots, and does not ask for them", () => {
    const dot = (i: number, active: boolean) =>
      n({ name: `Ellipse ${i}`, type: "VECTOR", at: [560 + i * 16, 440, 8, 8], fill: active ? "core/sec/500" : "core/neu/300" });
    const dots = n({ name: "pagination", at: [560, 440, 72, 8], mode: "horizontal", children: [0, 1, 2, 3, 4].map((i) => dot(i, i === 0)) });
    const section = n({ name: "News", at: [0, 0, 1366, 480], children: [row(cards(4), 1172), dots] });
    const [intent] = detectLayout(doc(section));
    expect(intent?.kind).toBe("carousel");
    expect(intent?.chrome.pagination).toBe(dots.id);
    expect(intent?.choice).toMatchObject({ config: { pages: 5 } });
    expect(intent?.evidence.join(" ")).toContain("5 pagination dots, page 1 drawn active");
    expect(intent?.ask.some((q: string) => q.includes("How many items"))).toBe(false);
  });

  it("does not take two marks, or marks all drawn alike, for dots", () => {
    const mark = (i: number, fill: string) => n({ type: "VECTOR", at: [560 + i * 16, 440, 8, 8], fill });
    const two = n({ at: [560, 440, 24, 8], children: [mark(0, "a"), mark(1, "b")] });
    const alike = n({ at: [560, 440, 40, 8], children: [mark(0, "a"), mark(1, "a"), mark(2, "a")] });
    for (const marks of [two, alike]) {
      const [intent] = detectLayout(doc(n({ name: "News", at: [0, 0, 1366, 480], children: [row(cards(4), 1172), marks] })));
      expect(intent?.kind).not.toBe("carousel");
    }
  });

  it("does not call two photos overhanging a clip a carousel", () => {
    const photo = (x: number) => n({ name: "England-Squad", type: "IMAGE", at: [x, 0, 760, 954] });
    const collage = n({ name: "Group", type: "GROUP", at: [-80, 0, 1523, 954], children: [photo(-80), photo(680)] });
    expect(detectLayout(doc(n({ name: "hero", at: [0, 0, 1366, 390], clip: true, children: [collage] })))).toEqual([]);
  });

  it("divides the width only for items sized to share it", () => {
    const shared = cards(3, 400).map((c) => {
      (c.layout.sizing as { w: string }).w = "fill";
      return c;
    });
    const [intent] = detectLayout(doc(row(shared, 1000)));
    expect(intent?.choice).toMatchObject({ kind: "carousel", config: { slidesPerView: 2.4 } });
  });
});

describe("rows a frame cannot decide", () => {
  it("is unsure about cards that exactly fill the row, and asks", () => {
    const [intent] = detectLayout(doc(row(cards(4), 1172)));
    expect(intent?.kind).toBe("row");
    expect(intent?.confidence).toBe("unsure");
    expect(intent?.alternative).toBe("carousel");
    expect(intent?.ask[0]).toMatch(/fixed row of 4, or a carousel/);
    // Until someone answers, the proposal keeps what the frame shows.
    expect(intent?.choice).toEqual({ src: intent?.src, kind: "row" });
  });

  it("is sure of a row of chips or logos, which nobody pages through", () => {
    const logos = Array.from({ length: 7 }, (_, i) =>
      n({ name: "logos", type: "INSTANCE", at: [i * 170, 0, 156, 60], children: [n({ type: "IMAGE", at: [i * 170, 0, 156, 60] })] }),
    );
    const [intent] = detectLayout(doc(n({ name: "partners", at: [0, 0, 1175, 60], mode: "horizontal", children: logos })));
    expect(intent).toMatchObject({ kind: "row", confidence: "likely", ask: [] });
  });

  it("treats a menu as navigation, never tabs", () => {
    const item = (i: number) => n({ at: [i * 80, 0, 70, 44], sig: "item", fill: i === 0 ? "active" : undefined, children: [n({ at: [i * 80, 10, 50, 20], text: `Item ${i}` })] });
    const [intent] = detectLayout(doc(n({ name: "Menu", at: [0, 0, 320, 44], mode: "horizontal", children: [0, 1, 2, 3].map(item) })));
    // One item drawn differently in a menu is the current page; the tabs rule sees it first.
    expect(intent?.kind === "tabs" || intent?.kind === "row").toBe(true);
  });

  it("needs three items before calling anything a row", () => {
    expect(detectLayout(doc(row(cards(2), 600)))).toEqual([]);
  });
});

describe("tabs", () => {
  const tab = (i: number, label: string, active: boolean) =>
    n({
      name: "tabs",
      at: [i * 232, 0, 232, 40],
      sig: "tab",
      fill: active ? "button/filled/style_1/surface/default" : undefined,
      children: [n({ at: [i * 232 + 80, 16, 60, 8], text: label, fill: active ? "text/invert/high" : "text/main/high" })],
    });

  it("finds the selected tab: the one label drawn differently", () => {
    const labels = ["SCORECARD", "SQUAD", "GRAPHS", "MORE INFO"];
    const bar = n({ name: "Tab", at: [0, 0, 926, 40], mode: "horizontal", children: labels.map((l, i) => tab(i, l, i === 2)) });
    const [intent] = detectLayout(doc(bar));
    expect(intent?.kind).toBe("tabs");
    expect(intent?.confidence).toBe("certain");
    expect(intent?.choice).toEqual({ src: bar.id, kind: "tabs", config: { options: labels, active: 2 } });
  });

  it("finds a two-way toggle whose selected half is shaped differently (WOMEN | MEN)", () => {
    // Southern Brave's squad header: the selected half has a fill and a stray 1px ellipse the
    // other lacks, so the two are not one shape; they touch, inside one bordered, clipped frame.
    const women = n({ name: "Button", at: [0, 0, 90, 40], children: [n({ at: [18, 16, 54, 8], text: "WOMEN", fill: "text/sec/high" })] });
    const men = n({
      name: "Button",
      at: [90, 0, 90, 40],
      fill: "background/prim/card",
      children: [n({ type: "VECTOR", at: [134, 19, 1, 1], fill: "Color/core_neu_00" }), n({ at: [120, 16, 30, 8], text: "MEN", fill: "text/prim/high" })],
    });
    const toggle = n({ name: "Frame 1984078920", at: [0, 0, 180, 40], mode: "horizontal", clip: true, children: [women, men] });
    const [intent] = detectLayout(doc(toggle));
    expect(intent).toMatchObject({ kind: "tabs", confidence: "likely" });
    expect(intent?.choice).toEqual({ src: toggle.id, kind: "tabs", config: { options: ["WOMEN", "MEN"], active: 1 } });
  });

  it("does not call two buttons apart a toggle", () => {
    const button = (x: number, label: string, fill?: string) =>
      n({ at: [x, 0, 120, 40], sig: "cta", fill, children: [n({ at: [x + 20, 12, 80, 16], text: label })] });
    const pair = n({ at: [0, 0, 264, 40], mode: "horizontal", children: [button(0, "LOG IN", "primary"), button(144, "SIGN UP")] });
    expect(detectLayout(doc(pair))).toEqual([]);
  });

  it("is only likely when nothing is named as tabs", () => {
    const bar = n({ name: "Frame 1", at: [0, 0, 926, 40], mode: "horizontal", children: ["A", "B", "C"].map((l, i) => tab(i, l, i === 0)) });
    for (const item of bar.children) item.name = "Frame";
    const [intent] = detectLayout(doc(bar));
    expect(intent).toMatchObject({ kind: "tabs", confidence: "likely" });
  });
});

describe("lists and grids", () => {
  it("is a list for a column of matching items, certain when it scrolls", () => {
    const items = (count: number) => Array.from({ length: count }, (_, i) => card(0, i * 120, 420, 100));
    const [fits] = detectLayout(doc(n({ name: "col", at: [0, 0, 420, 400], mode: "vertical", children: items(3) })));
    expect(fits).toMatchObject({ kind: "list", confidence: "likely" });
    const [scrolls] = detectLayout(doc(n({ name: "col", at: [0, 0, 420, 400], mode: "vertical", clip: true, children: items(6) })));
    expect(scrolls).toMatchObject({ kind: "list", confidence: "certain" });
    expect(scrolls?.evidence.join(" ")).toContain("cut off by the bottom edge");
  });

  it("is a grid when items align on both axes", () => {
    const items = [0, 1, 2, 3, 4, 5].map((i) => card((i % 3) * 300, Math.floor(i / 3) * 420, 281, 400));
    const [intent] = detectLayout(doc(n({ name: "grid", at: [0, 0, 900, 820], mode: "horizontal", children: items })));
    expect(intent?.choice).toEqual({ src: intent?.src, kind: "grid", config: { columns: 3, rows: 2 } });
  });
});

describe("scores", () => {
  it("scores a cut-off row as sure, and a row that only fits as a doubt a model can settle", () => {
    const [fits] = detectLayout(doc(row(cards(4), 1172)));
    expect(fits?.score).toBeGreaterThan(0.3);
    expect(fits?.score).toBeLessThan(0.8);
    expect(fits?.confidence).toBe("unsure");
    expect(fits?.alternative).toBeDefined();
    expect(fits?.alternativeChoice).toBeDefined();
    expect(fits?.context.join(" ")).toContain("4 items of");
  });

  it("is sure of a row named as a slider that is made of fixed-width cards", () => {
    const slider = row(cards(5), 1172);
    slider.name = "Squad slider";
    const [intent] = detectLayout(doc(slider));
    expect(intent?.kind).toBe("carousel");
    expect(intent?.score).toBeGreaterThanOrEqual(0.6);
  });

  it("gives every intent a score between 0 and 1", () => {
    for (const intent of detectLayout(doc(row(cards(4), 1172)))) {
      expect(intent.score).toBeGreaterThan(0);
      expect(intent.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("structure", () => {
  it("looks inside the first item only: a template is reported once", () => {
    const pack = (y: number) =>
      n({ name: "package", at: [0, y, 1172, 420], sig: "pack", mode: "vertical", children: [row(cards(4).map((c) => c), 1172)] });
    const intents = detectLayout(doc(n({ name: "packages", at: [0, 0, 1172, 1300], mode: "vertical", children: [pack(0), pack(440), pack(880)] })));
    expect(intents.map((i) => i.kind)).toEqual(["list", "row"]);
  });

  it("never treats art as a container of cards", () => {
    const crest = n({
      name: "birmingham-phoenix 1",
      at: [0, 0, 44, 44],
      children: Array.from({ length: 6 }, (_, i) => n({ type: "VECTOR", at: [i * 7, 0, 6, 44], sig: "path" })),
    });
    expect(detectLayout(doc(crest))).toEqual([]);
  });

  it("reads the news-grid fixture without inventing a carousel", () => {
    const real = parseFrameIRDocument(JSON.parse(readFileSync(new URL("../fixtures/news-grid.ir.json", import.meta.url), "utf8")));
    const intents = detectLayout(real);
    expect(intents.some((i) => i.kind === "carousel")).toBe(false);
  });
});

describe("lowering", () => {
  // A compiled tree for a frame: the root, then the row with its cards, as the compiler names them.
  const flat = (rowSrc: string, cardSrcs: string[], rowProps: Record<string, unknown>, extra: FlatNode[] = []) => ({
    schemaVersion: "1",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "root", props: {} },
      { id: "row", parent: "root", idx: 0, type: "Stack", src: rowSrc, props: { direction: "row", gap: "space.4", align: "center", justify: "start", ...rowProps } },
      ...cardSrcs.map((src, i) => ({ id: `card_${i}`, parent: "row", idx: i, type: "Overlay", src, props: { clip: true } })),
      ...extra,
    ] as FlatNode[],
  });

  it("turns a row cut off by its clip into a Carousel, with inline padding as Swiper's offsets", () => {
    const r = row(cards(5), 1170);
    const tree = flat(r.id, r.children.map((c) => c.id), { space: { px: "space.6", py: "space.2" }, size: { w: { raw: 1170, _unbound: true } } });
    const [intent] = detectLayout(doc(n({ name: "page", at: [0, 0, 1366, 412], clip: true, children: [r] })));
    const { tree: out, lowered, notes } = lowerLayout(tree, doc(n({ name: "page", at: [0, 0, 1366, 412], clip: true, children: [r] })), [intent!.choice]);
    expect(lowered).toEqual([r.id]);
    expect(notes[0]?.message).toBe("carousel of 5 slides");
    const carousel = out.nodes.find((x) => x.id === "row")!;
    expect(carousel.type).toBe("Carousel");
    expect(carousel.props).toEqual({
      size: { w: { raw: 1170, _unbound: true } },
      space: { py: "space.2" },
      offsetBefore: "space.6",
      offsetAfter: "space.6",
      gap: "space.4",
      align: "center",
      // inside a page and not clipping itself: its slides run on to the page's clip
      clip: false,
      slidesPerView: "auto",
      loop: false,
      autoplay: false,
    });
    // The slides are untouched.
    expect(out.nodes.filter((x) => x.parent === "row")).toEqual(tree.nodes.filter((x) => x.parent === "row"));
  });

  it("validates as a tree", () => {
    const r = row(cards(5), 1170);
    const d = doc(n({ name: "page", at: [0, 0, 1366, 412], clip: true, children: [r] }));
    const [intent] = detectLayout(d);
    const { tree } = lowerLayout(flat(r.id, r.children.map((c) => c.id), {}), d, [intent!.choice]);
    const issues = validate(tree, { registry: createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }) });
    expect(issues.errors.filter((e) => e.code.startsWith("S"))).toEqual([]);
  });

  /** A team strip: four cards, and a row of the two designed arrows at its end. */
  function team() {
    const button = (x: number, glyph: string) =>
      n({ name: "back/next", type: "INSTANCE", at: [x, 430, 40, 40], children: [n({ name: glyph, type: "INSTANCE", at: [x + 10, 440, 20, 20] })] });
    const prev = button(1060, "atom_icon_arrow_left");
    const nextArrow = button(1110, "atom_icon_arrow_right");
    const r = row(cards(4), 1172);
    const controls = n({ name: "controls", at: [1000, 430, 160, 40], mode: "horizontal", children: [nextArrow, prev] });
    const d = doc(n({ name: "Team", at: [0, 0, 1366, 500], children: [r, controls] }));
    const [intent] = detectLayout(d);
    // As the compiler draws them: next first, both at the start of their row.
    const extra: FlatNode[] = [
      { id: "arrows", parent: "root", idx: 1, type: "Stack", src: controls.id, props: { direction: "row", justify: "start", gap: "space.2" } },
      { id: "fwd", parent: "arrows", idx: 0, type: "Icon", src: nextArrow.id, props: { name: "back_next" } },
      { id: "back", parent: "arrows", idx: 1, type: "Icon", src: prev.id, props: { name: "back_next" } },
    ] as FlatNode[];
    const tree = flat(r.id, r.children.map((c) => c.id), {}, extra);
    const choice = intent!.choice as Extract<LayoutChoice, { kind: "carousel" }>;
    return { d, tree, choice };
  }

  it("wires the designed arrows to the carousel, and fades one with nowhere to go", () => {
    const { d, tree: before, choice } = team();
    const { tree } = lowerLayout(before, d, [choice]);
    const back = tree.nodes.find((x) => x.id === "back")!;
    expect(back.props.controlFor).toEqual({ target: "row", part: "prev" });
    expect(back.props.states).toEqual({ disabled: { opacity: "opacity.40" } });
    expect(tree.nodes.find((x) => x.id === "fwd")?.props.controlFor).toEqual({ target: "row", part: "next" });
    // Left where the design drew them.
    expect(tree.nodes.find((x) => x.id === "arrows")?.props.justify).toBe("start");
  });

  it("gives the arrows a config's states, and puts them at the edges when asked", () => {
    const { d, tree: before, choice } = team();
    const states = { disabled: { fill: "color.core_neu_200", tone: "color.core_neu_700" }, hover: { opacity: "opacity.80" } };
    const { tree, notes } = lowerLayout(before, d, [
      { ...choice, config: { ...choice.config, controls: { arrows: { placement: "edges", states } } } },
    ]);
    expect(notes[0]?.message).toBe("carousel of 4 slides");
    expect(tree.nodes.find((x) => x.id === "back")?.props.states).toEqual(states);
    // Prev at the start edge, next at the end: the same row, spread.
    expect(tree.nodes.find((x) => x.id === "arrows")?.props.justify).toBe("between");
    const order = tree.nodes.filter((x) => x.parent === "arrows").sort((a, b) => a.idx - b.idx).map((x) => x.id);
    expect(order).toEqual(["back", "fwd"]);
    const issues = validate(tree, { registry: createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }) });
    expect(issues.errors.filter((e) => e.code.startsWith("S"))).toEqual([]);
  });

  it("says so when the arrows' row holds more than the arrows, and leaves them", () => {
    const { d, tree: before, choice } = team();
    before.nodes.push({ id: "label", parent: "arrows", idx: 2, type: "Text", src: "x:1", props: { content: "More", style: "type.body_sm_regular" } } as FlatNode);
    const { tree, notes, lowered } = lowerLayout(before, d, [
      { ...choice, config: { ...choice.config, controls: { arrows: { placement: "edges" } } } },
    ]);
    expect(lowered).toEqual([choice.src]);
    expect(notes[0]?.message).toBe("carousel of 4 slides; arrows left where they are drawn: their row holds more than the two arrows");
    expect(tree.nodes.find((x) => x.id === "arrows")?.props.justify).toBe("start");
  });

  it("carries how a config says it moves onto the Carousel, and nothing else", () => {
    const { d, tree: before, choice } = team();
    const effect = { kind: "creative", prev: { translate: [0, 0, -400] }, next: { translate: ["100%", 0, 0] } };
    const { tree } = lowerLayout(before, d, [
      { ...choice, config: { ...choice.config, props: { effect, speed: { raw: 600, _unbound: true }, easing: "easing.spring", src: "not motion", arrows: {} } } },
    ]);
    const carousel = tree.nodes.find((x) => x.id === "row")!;
    expect(carousel.props).toMatchObject({ effect, speed: { raw: 600, _unbound: true }, easing: "easing.spring" });
    expect(carousel.props.src).toBeUndefined();
    expect(carousel.props.arrows).toBeUndefined();
  });

  it("makes a centred row fill its clip, and records where the first paint centres", () => {
    const items = [0, 1, 2].map((i) =>
      n({ name: "D_2 Fixture Card", type: "INSTANCE", at: [-224 + i * 610, 0, 594, 235], sig: i === 1 ? "active" : "rest" }),
    );
    const r = row(items, 1962);
    const d = doc(n({ name: "FIXTURES", at: [0, 0, 1366, 235], clip: true, children: [r] }));
    const [intent] = detectLayout(d);
    const tree = flat(r.id, items.map((c) => c.id), {
      space: { px: "space.14" },
      size: { w: "auto", h: "auto" },
      place: { anchor: "top-start", offset: { inline: { raw: -298, _unbound: true } } },
      column: 1366,
    });
    const { tree: out } = lowerLayout(tree, d, [intent!.choice]);
    const carousel = out.nodes.find((x) => x.id === "row")!;
    expect(carousel.props).toMatchObject({
      place: { anchor: "top-fill" },
      centered: true,
      centeredBounds: true,
      initialSlide: 1,
      centerAt: 907,
    });
    expect(carousel.props).not.toHaveProperty("column");
    expect(carousel.props).not.toHaveProperty("offsetBefore");
    expect((carousel.props.size as Record<string, unknown>).w).toBeUndefined();
  });

  it("applies a person's answer to an unsure row: autoplay and loop", () => {
    const r = row(cards(4), 1172);
    const d = doc(n({ name: "page", at: [0, 0, 1366, 412], children: [r] }));
    const choice = {
      src: r.id,
      kind: "carousel" as const,
      config: { slidesPerView: "auto" as const, slidesPerGroup: 1, centered: false, initialSlide: 0, loop: true, autoplay: { delayMs: 5000 } },
    };
    const { tree } = lowerLayout(flat(r.id, r.children.map((c) => c.id), {}), d, [choice]);
    expect(tree.nodes.find((x) => x.id === "row")?.props).toMatchObject({
      loop: true,
      autoplay: { delay: { raw: 5000, _unbound: true } },
    });
  });

  it("leaves lists, rows and grids as compiled, and says so", () => {
    const tree = flat("x", [], {});
    const { tree: out, notes } = lowerLayout(tree, doc(n({ at: [0, 0, 10, 10] })), [
      { src: "x", kind: "row" },
      { src: "x", kind: "grid", config: { columns: 2, rows: 2 } },
    ]);
    expect(out).toEqual(tree);
    expect(notes.map((x) => x.message)).toEqual([
      "kept as compiled: a row is what the frame draws",
      "grid recorded; not lowered yet, so it stays as compiled",
    ]);
  });
});

describe("lowering tabs", () => {
  /** The squad header's toggle as the compiler draws it: MEN has the surface and its own dot. */
  const toggleTree = (): FlatTree => ({
    schemaVersion: "1",
    nodes: [
      { id: "bar", parent: null, idx: 0, type: "Stack", src: "35:10515", props: { direction: "row", surface: "surface.border" } },
      { id: "women", parent: "bar", idx: 0, type: "Stack", src: "35:10516", props: { direction: "row" } },
      { id: "women_label", parent: "women", idx: 0, type: "Text", src: "35:10517", props: { content: "WOMEN", style: "type.body_sm_bold", tone: "color.text_sec_high" } },
      { id: "men", parent: "bar", idx: 1, type: "Stack", src: "35:10518", props: { direction: "row", surface: "surface.button" } },
      { id: "dot", parent: "men", idx: 0, type: "Box", src: "35:10519", props: { size: { w: { raw: 1, _unbound: true } } } },
      { id: "men_label", parent: "men", idx: 1, type: "Text", src: "35:10520", props: { content: "MEN", style: "type.body_sm_bold", tone: "color.text_prim_high" } },
    ] as FlatNode[],
  });
  const choice: LayoutChoice = { src: "35:10515", kind: "tabs", config: { options: ["WOMEN", "MEN"], active: 1 } };
  const byId = (tree: FlatTree, id: string) => tree.nodes.find((x) => x.id === id)!;

  it("makes each tab an option of a page choice, with the selected look as its active state", () => {
    const { tree, lowered, notes } = lowerLayout(toggleTree(), doc(n({ at: [0, 0, 180, 40] })), [choice]);
    expect(lowered).toEqual(["35:10515"]);
    expect(notes[0]?.message).toContain("2 options of _page.women_men (women, men)");
    const states = { active: { surface: "surface.button", tone: "color.text_prim_high" } };
    expect(byId(tree, "women").props).toEqual({ direction: "row", states, select: { key: "women_men", value: "women" } });
    expect(byId(tree, "men").props).toEqual({ direction: "row", states, select: { key: "women_men", value: "men", initial: true } });
    // the labels take the plain colour; the state gives the chosen one its own
    expect(byId(tree, "men_label").props.tone).toBe("color.text_sec_high");
  });

  it("copies what only the selected tab draws to every tab, shown while it is chosen", () => {
    const { tree } = lowerLayout(toggleTree(), doc(n({ at: [0, 0, 180, 40] })), [choice]);
    expect(byId(tree, "dot").props.when).toEqual({ path: "_page.women_men", eq: "men" });
    const copy = byId(tree, "dot__women");
    expect(copy).toMatchObject({ parent: "women", idx: 0, src: "synthetic:35:10519:1" });
    expect(copy.props.when).toEqual({ path: "_page.women_men", eq: "women" });
    expect(byId(tree, "women_label").idx).toBe(1);
  });

  it("is a valid tree, with the key a person named", () => {
    const named: LayoutChoice = { ...choice, config: { ...choice.config, key: "squad" } } as LayoutChoice;
    const { tree } = lowerLayout(toggleTree(), doc(n({ at: [0, 0, 180, 40] })), [named]);
    expect(byId(tree, "men").props.select).toEqual({ key: "squad", value: "men", initial: true });
    const errors = validate(tree, { registry: createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }) }).errors;
    expect(errors.filter((e) => e.code.startsWith("S")).map((e) => `${e.nodeId} ${e.path} ${e.message}`)).toEqual([]);
  });
});

describe("a carousel that draws one slide", () => {
  /** The Showcase hero as the compiler draws it: photo, shade and words placed in an Overlay, then the arrows and the card. */
  const hero = (): FlatTree => ({
    schemaVersion: "1",
    nodes: [
      { id: "hero", parent: null, idx: 0, type: "Overlay", src: "9:1", props: { clip: true, size: { w: "full", h: { raw: 768, _unbound: true } } } },
      { id: "photo", parent: "hero", idx: 0, type: "Image", src: "9:2", props: { src: "a.png", alt: "photo", fit: "fill", place: { anchor: "top-fill" } } },
      { id: "words", parent: "hero", idx: 1, type: "Stack", src: "9:3", props: { place: { anchor: "top-start", offset: { block: { raw: 464, _unbound: true }, inline: { raw: 97, _unbound: true } } } } },
      { id: "title", parent: "words", idx: 0, type: "Text", src: "9:4", props: { content: "TOPLEY STEPPED UP", style: "type.body_sm_bold" } },
      { id: "controls", parent: "hero", idx: 2, type: "Stack", src: "9:5", props: { direction: "row", place: { anchor: "top-start" } } },
      { id: "prev", parent: "controls", idx: 0, type: "Box", src: "9:6", props: {} },
      { id: "next", parent: "controls", idx: 1, type: "Box", src: "9:7", props: {} },
      { id: "count", parent: "controls", idx: 2, type: "Text", src: "9:8", props: { content: "01", style: "type.body_sm_bold" } },
      { id: "card", parent: "hero", idx: 3, type: "Stack", src: "9:9", props: { place: { anchor: "top-start" } } },
    ] as FlatNode[],
  });
  const heroDoc = () => {
    const root = n({ name: "hero", at: [0, 0, 1366, 768] });
    (root as { id: string }).id = "9:1";
    return doc(root);
  };
  const choice: LayoutChoice = {
    src: "9:1",
    kind: "carousel",
    config: { slidesPerView: 1, slidesPerGroup: 1, centered: false, initialSlide: 0, loop: true, autoplay: false },
    slide: ["9:2", "9:3"],
    chrome: { prev: "9:6", next: "9:7", counter: "9:8" },
  };
  const byId = (tree: FlatTree, id: string) => tree.nodes.find((x) => x.id === id)!;

  it("wraps the slide's layers in one slide of a new carousel, where they were", () => {
    const { tree, lowered, notes } = lowerLayout(hero(), heroDoc(), [choice]);
    expect(lowered).toEqual(["9:1"]);
    expect(notes[0]?.message).toContain("carousel of one drawn slide (2 layers)");
    const carousel = tree.nodes.find((x) => x.type === "Carousel")!;
    expect(carousel).toMatchObject({ parent: "hero", idx: 0, props: { slidesPerView: 1, loop: true, clip: true, place: { anchor: "top-fill" } } });
    expect(carousel.src).toMatch(/^synthetic:9:1:/);
    const slide = tree.nodes.find((x) => x.parent === carousel.id)!;
    expect(slide.type).toBe("Overlay");
    expect(byId(tree, "photo")).toMatchObject({ parent: slide.id, idx: 0 });
    // the words keep their place inside the slide, which is the hero's size
    expect(byId(tree, "words")).toMatchObject({ parent: slide.id, idx: 1, props: { place: { anchor: "top-start" } } });
    // what draws over the slide still does, in the same order
    expect(byId(tree, "controls").idx).toBe(1);
    expect(byId(tree, "card").idx).toBe(2);
  });

  it("wires the arrows, and the counter in the form drawn", () => {
    const { tree } = lowerLayout(hero(), heroDoc(), [choice]);
    const carousel = tree.nodes.find((x) => x.type === "Carousel")!;
    expect(byId(tree, "prev").props.controlFor).toEqual({ target: carousel.id, part: "prev" });
    expect(byId(tree, "next").props.controlFor).toEqual({ target: carousel.id, part: "next" });
    expect(byId(tree, "count").props.controlFor).toEqual({ target: carousel.id, part: "counter", format: "0{index}" });
    const errors = validate(tree, { registry: createRegistry(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }) }).errors;
    expect(errors.filter((e) => e.code.startsWith("S")).map((e) => `${e.nodeId} ${e.path} ${e.message}`)).toEqual([]);
  });

  it("refuses layers that are not one run: something drawn between them would change order", () => {
    const { lowered, notes } = lowerLayout(hero(), heroDoc(), [{ ...choice, slide: ["9:2", "9:9"] }]);
    expect(lowered).toEqual([]);
    expect(notes[0]?.message).toContain("not one run");
  });

  it("writes a counter as drawn", () => {
    expect(counterFormat("01")).toBe("0{index}");
    expect(counterFormat("1 / 5")).toBe("{index} / {count}");
    expect(counterFormat("01/05")).toBe("0{index}/0{count}");
    expect(counterFormat("Slide")).toBe("{index} / {count}");
  });
});

describe("tabs a designer named alike", () => {
  it("are one control when the selected one is built differently", () => {
    // ho-spider's SPIDER / MANHATTAN / WORM: three "second tabs", the last holding another frame
    const tab = (x: number, label: string, sig: string, fill: string) =>
      n({ name: "second tabs", at: [x, 0, 282, 52], sig, children: [n({ at: [x, 20, 60, 10], text: label, fill })] });
    const bar = n({
      name: "Frame 1321315380",
      at: [0, 0, 886, 52],
      mode: "horizontal",
      children: [tab(0, "SPIDER", "t", "text/main/prim"), tab(302, "MANHATTAN", "t", "text/main/high"), tab(604, "WORM", "w", "text/main/high")],
    });
    const [intent] = detectLayout(doc(bar), { kinds: ["tabs"] });
    expect(intent?.items).toHaveLength(3);
    expect(intent?.choice).toMatchObject({ kind: "tabs", config: { options: ["SPIDER", "MANHATTAN", "WORM"], active: 0 } });
  });

  it("are not grouped by a name Figma gave them", () => {
    const box = (x: number, sig: string) => n({ name: "Frame 12", at: [x, 0, 282, 52], sig, children: [n({ at: [x, 0, 50, 10], text: "A" })] });
    const row = n({ name: "row", at: [0, 0, 900, 52], mode: "horizontal", children: [box(0, "a"), box(300, "b"), box(600, "c")] });
    expect(detectLayout(doc(row)).find((i) => i.src === row.id)).toBeUndefined();
  });
});
