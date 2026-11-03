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
import { validate, type FlatNode } from "@fanos/dsl";
import { detectLayout } from "../src/layout/detect.js";
import { lowerLayout } from "../src/layout/lower.js";

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

  it("leaves lists, rows, grids and tabs as compiled, and says so", () => {
    const tree = flat("x", [], {});
    const { tree: out, notes } = lowerLayout(tree, doc(n({ at: [0, 0, 10, 10] })), [
      { src: "x", kind: "row" },
      { src: "x", kind: "tabs", config: { options: ["A", "B"], active: 0 } },
    ]);
    expect(out).toEqual(tree);
    expect(notes.map((x) => x.message)).toEqual([
      "kept as compiled: a row is what the frame draws",
      "tabs recorded; not lowered yet, so it stays as compiled",
    ]);
  });
});
