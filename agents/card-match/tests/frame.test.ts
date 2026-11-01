import { describe, expect, it } from "vitest";
import {
  alignmentInBox,
  alignmentOf,
  type Bundle,
  clipOf,
  fitOf,
  gradientOf,
  gridNudge,
  isArtPlate,
  keepWhatHelps,
  lift,
  measuredPlates,
  noOverrides,
  placeOf,
  tokensOf,
  vectorArt,
  viewportOf,
  visibleBox,
} from "../src/frame.ts";
import type { IrNode, Toolchain } from "../src/toolchain.ts";

const layer = (raw: string, rotation = 0): IrNode => ({
  id: "1:1",
  name: "fade",
  type: "VECTOR",
  geometry: { bbox: { x: 0, y: 0, w: 164, h: 227 }, rotation },
  fill: { raw, unbound: true },
});

describe("gradientOf", () => {
  it("places stops where the Figma matrix puts them", () => {
    const gradient = gradientOf(
      layer(
        "GRADIENT_LINEAR(#0f1855 0%, #0f1855b2 44.8%, #0f185500 100%; m=[1.2103,0.0126,-0.0063,0,8.7457,-3.8925])",
      ),
    );
    expect(gradient?.degree).toBe(90);
    // measured from the design: the fade reaches nothing at about 135 of 164 px, 82%
    expect(gradient?.stops.map((stop) => stop.percent)).toEqual([0.52, 37.54, 83.14]);
    expect(gradient?.stops.map((stop) => stop.opacity)).toEqual([100, 69.8, 0]);
  });

  it("turns with the layer", () => {
    const gradient = gradientOf(
      layer("GRADIENT_LINEAR(#000000 0%, #00000000 100%; m=[1,0,0,0,1,0])", 180),
    );
    expect(gradient?.degree).toBe(270);
  });

  it("reverses a gradient that runs backwards", () => {
    const gradient = gradientOf(
      layer("GRADIENT_LINEAR(#000000 0%, #ffffff 100%; m=[-1,0,1,0,1,0])"),
    );
    expect(gradient?.degree).toBe(270);
    expect(gradient?.stops.map((stop) => stop.percent)).toEqual([0, 100]);
  });

  it("leaves paints it cannot draw exactly", () => {
    expect(gradientOf(layer("SOLID(#000000)"))).toBeUndefined();
    expect(
      gradientOf(layer("GRADIENT_LINEAR(#000000 0%, #ffffff 100%; m=[1,1,0,0,1,0])")),
    ).toBeUndefined();
  });
});

describe("fitOf", () => {
  it("takes a screenshot at the layer's own shape", () => {
    expect(fitOf({ width: 2732, height: 624 }, { w: 1366, h: 312 })).toEqual({ scale: 2 });
  });

  it("takes a rounding of a pixel", () => {
    expect(fitOf({ width: 524, height: 16 }, { w: 262, h: 7.68 })).toEqual({ scale: 2 });
  });

  it("flags a few pixels of padding, to be placed by search", () => {
    expect(fitOf({ width: 1028, height: 208 }, { w: 514, h: 99 })).toEqual({
      scale: 2,
      extraW: 0,
      extraH: 5,
    });
  });

  it("refuses what no padding explains", () => {
    expect(fitOf({ width: 2732, height: 3822 }, { w: 1366, h: 584 })).toHaveProperty("problem");
    expect(fitOf({ width: 160, height: 824 }, { w: 281, h: 412 })).toHaveProperty("problem");
  });
});

describe("visibleBox", () => {
  const node = (id: string, x: number, y: number, w: number, h: number, clipsContent = false) => ({
    id,
    name: id,
    type: "FRAME",
    geometry: { bbox: { x, y, w, h } },
    clipsContent,
  });
  const photo = node("photo", 3112, 1786, 699, 393);
  const card = node("card", 3281, 1804, 281, 375, true);
  const bundle = {
    doc: { root: card },
    byId: new Map([
      ["card", card],
      ["photo", photo],
    ]),
    parents: new Map([
      ["card", null],
      ["photo", "card"],
    ]),
  } as unknown as Bundle;

  it("cuts a photo to the card that clips it, as Figma exports it", () => {
    expect(visibleBox(bundle, "photo")).toEqual({ x: 3281, y: 1804, w: 281, h: 375 });
    expect(fitOf({ width: 562, height: 750 }, visibleBox(bundle, "photo") as never)).toEqual({
      scale: 2,
    });
  });

  it("has nothing for a layer outside the frame", () => {
    bundle.byId.set("gone", node("gone", 0, 0, 10, 10));
    bundle.parents.set("gone", "card");
    expect(visibleBox(bundle, "gone")).toBeUndefined();
  });
});

describe("placeOf", () => {
  const node = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => ({
    id,
    name: id,
    type: "FRAME",
    geometry: { bbox: { x, y, w, h } },
    ...extra,
  });
  const bundleOf = (
    root: ReturnType<typeof node>,
    rest: Array<[ReturnType<typeof node>, string]>,
  ) =>
    ({
      doc: { root },
      byId: new Map([[root.id, root], ...rest.map(([n]) => [n.id, n] as const)]),
      parents: new Map<string, string | null>([
        [root.id, null],
        ...rest.map(([n, parent]) => [n.id, parent] as const),
      ]),
    }) as unknown as Bundle;

  it("takes a layer's overflow into its box: a strip 213 tall drew 237", () => {
    const deep = node("deep", 2887, 900, 1962, 111);
    const cards = node("cards", 3185, 776, 1366, 227, { clipsContent: true, children: [deep] });
    const strip = node("strip", 3185, 766, 1366, 213, { children: [cards] });
    const root = node("root", 3185, 706, 1366, 312, { children: [strip] });
    const bundle = bundleOf(root, [
      [strip, "root"],
      [cards, "strip"],
      [deep, "cards"],
    ]);
    expect(placeOf(bundle, "strip", { width: 2732, height: 474 })).toEqual({
      box: { x: 3185, y: 766, w: 1366, h: 237 },
      fit: { scale: 2 },
    });
  });

  it("takes a shadow into its box", () => {
    const bar = node("bar", 0, 0, 100, 50, {
      effects: [{ type: "DROP_SHADOW", x: 0, y: 2, blur: 10, spread: 0 }],
    });
    const root = node("root", -50, -50, 400, 400, { children: [bar] });
    const placed = placeOf(bundleOf(root, [[bar, "root"]]), "bar", { width: 240, height: 140 });
    expect(placed).toEqual({ box: { x: -10, y: -8, w: 120, h: 70 }, fit: { scale: 2 } });
  });

  it("reads a narrow screenshot of a card past the frame's edge as the end still in view", () => {
    const card = node("card", 1188, 0, 281, 412);
    const root = node("root", 0, 0, 1170, 412, { children: [card] });
    const placed = placeOf(bundleOf(root, [[card, "root"]]), "card", { width: 160, height: 824 });
    expect(placed).toEqual({
      box: { x: 1188, y: 0, w: 80, h: 412 },
      fit: { scale: 2 },
      partial: true,
    });
  });

  it("does not read a narrow screenshot as part of a layer inside the frame", () => {
    const card = node("card", 0, 0, 281, 412);
    const root = node("root", 0, 0, 1170, 412, { children: [card] });
    const placed = placeOf(bundleOf(root, [[card, "root"]]), "card", { width: 160, height: 824 });
    expect(placed?.fit).toHaveProperty("problem");
  });

  it("falls back to where a layer shows, for a photo its card clips", () => {
    const photo = node("photo", 3112, 1786, 699, 393);
    const card = node("card", 3281, 1804, 281, 375, { clipsContent: true, children: [photo] });
    const placed = placeOf(bundleOf(card, [[photo, "card"]]), "photo", { width: 562, height: 750 });
    expect(placed?.box).toEqual({ x: 3281, y: 1804, w: 281, h: 375 });
  });
});

describe("alignmentOf", () => {
  const image = (rows: Array<[number, number] | null>, width = 100) => {
    const data = Buffer.alloc(width * rows.length * 4);
    rows.forEach((row, y) => {
      if (!row) return;
      for (let x = row[0]; x <= row[1]; x++) data[(y * width + x) * 4 + 3] = 255;
    });
    return { width, height: rows.length, data };
  };

  it("sees centred lines", () => {
    expect(alignmentOf(image([[30, 69], null, [0, 99]]))).toBe("center");
  });

  it("sees lines ending together", () => {
    expect(alignmentOf(image([[60, 99], null, [0, 99]]))).toBe("end");
  });

  it("says nothing for lines that start together, or one line", () => {
    expect(alignmentOf(image([[0, 40], null, [0, 99]]))).toBeUndefined();
    expect(alignmentOf(image([[0, 40]]))).toBeUndefined();
  });
});

describe("pictures of single layers (IR 1.9.0)", () => {
  const plate = (nodeId: string, name: string) => ({ nodeId, name, png: Buffer.from(nodeId) });
  const bundle = (plates: ReturnType<typeof plate>[]) =>
    ({ doc: { rootNodeId: "root" }, plates }) as unknown as Bundle;

  it("measures against the frame's own picture when the export has one", () => {
    const b = bundle([
      plate("sec", "Section-1-2.png"),
      plate("root", "art-root-Frame-root.png"),
      plate("crest", "art-vector-Crest-crest.png"),
    ]);
    expect(measuredPlates(b).map((p) => p.nodeId)).toEqual(["root"]);
  });

  it("falls back to the section pictures, and never measures against a layer's art", () => {
    const b = bundle([
      plate("sec", "Section-1-2.png"),
      plate("crest", "art-vector-Crest-crest.png"),
    ]);
    expect(measuredPlates(b).map((p) => p.nodeId)).toEqual(["sec"]);
    // an export from before 1.9.0 has only sections, and nothing about it changes
    expect(measuredPlates(bundle([plate("sec", "a.png"), plate("sec2", "b.png")]))).toHaveLength(2);
  });

  it("says which pictures are art, and that the frame's own is not", () => {
    const b = bundle([]);
    expect(isArtPlate(b, plate("m", "art-mask-Mask-m.png"))).toBe(true);
    expect(isArtPlate(b, plate("root", "art-root-Frame-root.png"))).toBe(false);
    expect(isArtPlate(b, plate("s", "Section-s.png"))).toBe(false);
  });

  it("places a picture from its render box, so a shadow needs no search", () => {
    const node = (id: string, bbox: object, extra: object = {}) => ({
      id,
      name: id,
      type: "FRAME",
      geometry: { bbox, ...extra },
    });
    // 100x50 layout box with a 10px shadow: its picture is 120x70, at 2x 240x140
    const card = node(
      "card",
      { x: 10, y: 10, w: 100, h: 50 },
      { renderBbox: { x: 0, y: 0, w: 120, h: 70 } },
    );
    const root = node("root", { x: 0, y: 0, w: 400, h: 400 });
    const b = {
      doc: { root },
      byId: new Map<string, unknown>([
        ["root", root],
        ["card", card],
      ]),
      parents: new Map<string, string | null>([
        ["root", null],
        ["card", "root"],
      ]),
    } as unknown as Bundle;
    const placed = placeOf(b, "card", { width: 240, height: 140 });
    expect(placed).toEqual({ box: { x: 0, y: 0, w: 120, h: 70 }, fit: { scale: 2 } });
  });

  describe("vector art", () => {
    const tools = {
      png: {
        read: (png: Buffer) => ({
          width: png.length > 0 ? 160 : 0,
          height: 160,
          data: Buffer.alloc(0),
        }),
      },
    } as unknown as Toolchain;
    const crest = {
      id: "crest",
      name: "Crest",
      type: "GROUP",
      geometry: { bbox: { x: 0, y: 0, w: 80, h: 80 }, renderBbox: { x: 0, y: 0, w: 80, h: 80 } },
      children: [
        { id: "path", name: "p", type: "VECTOR", geometry: { bbox: { x: 0, y: 0, w: 80, h: 80 } } },
      ],
    };
    const root = {
      id: "root",
      name: "Frame",
      type: "FRAME",
      geometry: { bbox: { x: 0, y: 0, w: 400, h: 400 } },
      children: [crest],
    };
    const b = {
      doc: { rootNodeId: "root", root },
      byId: new Map<string, unknown>([
        ["root", root],
        ["crest", crest],
        ["path", crest.children[0]],
      ]),
      parents: new Map<string, string | null>([
        ["root", null],
        ["crest", "root"],
        ["path", "crest"],
      ]),
      plates: [{ nodeId: "crest", name: "art-vector-Crest-crest.png", png: Buffer.from("x") }],
    } as unknown as Bundle;
    const built = (notes: Array<{ kind: string; irId: string }>) =>
      ({ notes, tree: { nodes: [{ id: "crest", src: "crest" }] } }) as never;

    it("takes a crest the compiler could only draw as a box, from its own picture", () => {
      expect(vectorArt(tools, b, built([{ kind: "decorative-vector", irId: "path" }]))).toEqual([
        "crest",
      ]);
    });

    it("leaves art the compiler already drew properly", () => {
      expect(vectorArt(tools, b, built([]))).toEqual([]);
    });
  });
});

describe("clipOf", () => {
  const node = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => ({
    id,
    name: id,
    type: "FRAME",
    geometry: { bbox: { x, y, w, h } },
    ...extra,
  });
  const bundleOf = (list: Array<[ReturnType<typeof node>, string | null]>) =>
    ({
      byId: new Map(list.map(([n]) => [n.id, n])),
      parents: new Map(list.map(([n, parent]) => [n.id, parent])),
    }) as unknown as Bundle;

  it("stops a photo at the frame that clips it, however far its own box runs", () => {
    // the photo is 954 tall and the header shows 390 of it: the rest of a screenshot there is
    // other layers, such as the fixture cards below the header
    const photo = node("photo", 0, 33, 759, 954);
    const header = node("header", 0, 76, 1366, 390, { clipsContent: true });
    const root = node("root", 0, 0, 1366, 3540, { clipsContent: true });
    const bundle = bundleOf([
      [root, null],
      [header, "root"],
      [photo, "header"],
    ]);
    expect(clipOf(bundle, "photo")).toEqual({ x: 0, y: 76, w: 759, h: 390 });
  });

  it("keeps the whole box when nothing above it clips", () => {
    const photo = node("photo", 10, 10, 50, 60);
    const root = node("root", 0, 0, 100, 100);
    const bundle = bundleOf([
      [root, null],
      [photo, "root"],
    ]);
    expect(clipOf(bundle, "photo")).toEqual({ x: 10, y: 10, w: 50, h: 60 });
  });

  it("has nothing for a layer wholly outside what clips it", () => {
    const photo = node("photo", 0, 500, 50, 60);
    const header = node("header", 0, 0, 100, 100, { clipsContent: true });
    const bundle = bundleOf([
      [header, null],
      [photo, "header"],
    ]);
    expect(clipOf(bundle, "photo")).toBeUndefined();
  });
});

describe("lift", () => {
  const black = {
    box: { x: 0, y: 0, w: 10, h: 10 },
    gradient: {
      type: "linear-gradient" as const,
      degree: 180,
      stops: [
        { color: "#000000", opacity: 50, percent: 0 },
        { color: "#000000", opacity: 50, percent: 100 },
      ],
    },
  };
  const pixel = () => Buffer.from([100, 100, 100, 255]);

  it("takes a gradient out of a pixel inside its box", () => {
    const data = pixel();
    lift(data, 0, black, 5, 5);
    // painted over at half cover, so what was there is twice the pixel
    expect(data[0]).toBe(200);
  });

  it("leaves a pixel outside the box alone: nothing was painted over it", () => {
    const data = pixel();
    lift(data, 0, black, 15, 5);
    lift(data, 0, black, 5, -1);
    expect([...data]).toEqual([100, 100, 100, 255]);
  });
});

describe("keepWhatHelps", () => {
  const start = noOverrides();
  const fixes = {
    ...start,
    gradients: ["g1", "g2"],
    crops: ["c1"],
    texts: ["t1"],
  };
  // raw gradients are fine alone and wrong over crops, as on the team page
  const score = async (o: typeof fixes) =>
    o.crops.length > 0 && o.gradients.length > 0 ? 76 : o.crops.length > 0 ? 96.8 : 82.7;

  it("takes out the fix whose absence helps, and keeps the rest", async () => {
    const got = await keepWhatHelps(fixes, start, 82.5, score);
    expect(got.overrides.gradients).toEqual([]);
    expect(got.overrides.crops).toEqual(["c1"]);
    expect(got.overrides.texts).toEqual(["t1"]);
    expect(got.match).toBe(96.8);
    expect(got.undone[0]).toContain("raw gradients");
  });

  it("goes back to the plain compile when no combination beats it", async () => {
    const got = await keepWhatHelps(fixes, start, 90, async () => 70);
    expect(got.overrides).toEqual(start);
    expect(got.match).toBe(90);
    expect(got.undone.at(-1)).toContain("every fix");
  });

  it("does not measure again what the caller has just measured", async () => {
    const tried: number[] = [];
    const got = await keepWhatHelps(
      fixes,
      start,
      80,
      async (o) => {
        const worth =
          80 +
          2 *
            (Number(o.gradients.length > 0) +
              Number(o.crops.length > 0) +
              Number(o.texts.length > 0));
        tried.push(worth);
        return worth;
      },
      86,
    );
    expect(got.overrides).toEqual(fixes);
    // only the two fixes left out in turn: the whole was known
    expect(tried).toHaveLength(2);
  });

  it("keeps every fix when each one helps, having looked at each", async () => {
    const tried: number[] = [];
    const got = await keepWhatHelps(fixes, start, 80, async (o) => {
      // each fix is worth two points
      const worth =
        80 +
        2 *
          (Number(o.gradients.length > 0) +
            Number(o.crops.length > 0) +
            Number(o.texts.length > 0));
      tried.push(worth);
      return worth;
    });
    expect(got.overrides).toEqual(fixes);
    expect(got.undone).toEqual([]);
    // the whole, then the two that interact left out in turn
    expect(tried).toHaveLength(3);
  });

  it("never takes out a fix that wasn't in the first pass", async () => {
    const only = { ...start, crops: ["c1"] };
    const got = await keepWhatHelps(only, start, 90, async (o) => (o.crops.length ? 85 : 90));
    // the crops hurt, and they are the only fix there is to take out
    expect(got.overrides.crops).toEqual([]);
  });
});

describe("gridNudge", () => {
  const root = { x: 3185, y: 2727, w: 1366, h: 538 };

  it("moves a layer starting between pixels onto the next one", () => {
    // 60.642 css px is 121.28 device px at 2x: the next whole pixel is 122
    const nudge = gridNudge({ x: 3283, y: 2787.642, w: 1170, h: 444 }, root, 2);
    expect(nudge.x).toBe(0);
    expect((60.642 + nudge.y) * 2).toBeCloseTo(122, 3);
  });

  it("leaves a layer that is on the grid, including to a thousandth of a pixel", () => {
    expect(gridNudge({ x: 3185, y: 2727, w: 10, h: 10 }, root, 2)).toEqual({ x: 0, y: 0 });
    expect(gridNudge({ x: 3185.0002, y: 2727.5, w: 10, h: 10 }, root, 2)).toEqual({ x: 0, y: 0 });
  });
});

describe("alignmentInBox", () => {
  // columns of ink in a box 200 wide and 10 tall
  const inked = (...runs: Array<[number, number]>) => {
    const data = Buffer.alloc(200 * 10 * 4);
    for (const [from, to] of runs) {
      for (let x = from; x <= to; x++) {
        for (let y = 0; y < 10; y++) data[(y * 200 + x) * 4 + 3] = 255;
      }
    }
    return { width: 200, height: 10, data };
  };

  it("sees text in the middle of a wider box", () => {
    expect(alignmentInBox(inked([50, 149]))).toBe("center");
  });

  it("sees text at the end of a wider box", () => {
    expect(alignmentInBox(inked([100, 199]))).toBe("end");
  });

  it("says nothing for text at the start, or filling the box", () => {
    expect(alignmentInBox(inked([0, 99]))).toBeUndefined();
    expect(alignmentInBox(inked([0, 199]))).toBeUndefined();
  });

  it("ignores a turned label of the same colour crossing the box", () => {
    expect(alignmentInBox(inked([0, 12], [50, 149]))).toBe("center");
  });
});

describe("viewportOf", () => {
  const bundleWith = (fontSize: number) =>
    ({
      themeRaw: {
        tokens: {
          t: {
            typography_desktop: { dp_3_regular: { size: 36 } },
            typography_tablet: { dp_3_regular: { size: 28 } },
            typography_mobile: { dp_3_regular: { size: 28 } },
          },
        },
      },
      byId: new Map([["1", { text: { styleRef: "dp_3/regular", fontSize } }]]),
    }) as unknown as Bundle;

  it("takes the band whose type sizes the design uses, not the width of the frame", () => {
    expect(viewportOf(bundleWith(36))).toBe(1280);
  });

  it("takes the widest band that agrees", () => {
    expect(viewportOf(bundleWith(28))).toBe(768);
  });
});

describe("tokensOf", () => {
  const theme = {
    tokens: {
      a: {
        color: { light: { far: "#ffffff", close: "#101010", plain: "#000000" } },
        spacing: { spacing_2_5: 10 },
      },
    },
  };

  it("names tokens as a node refers to them", () => {
    expect(tokensOf(theme, "space")).toEqual([{ ref: "space.2_5", value: 10 }]);
  });

  it("puts the nearest colour first", () => {
    expect(tokensOf(theme, "color", "#121212").map((row) => row.ref)).toEqual([
      "color.close",
      "color.plain",
      "color.far",
    ]);
  });
});
