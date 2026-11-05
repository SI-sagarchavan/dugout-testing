import { describe, expect, it } from "vitest";
import type { Bundle } from "../src/frame.ts";
import { unpaintedLayers } from "../src/frame.ts";
import {
  clampRegion,
  LookInputError,
  nodesAt,
  parseDifferences,
  scaleFor,
  tilesOf,
  toFrameBox,
} from "../src/look.ts";

describe("parseDifferences", () => {
  const reply = (body: string) => `Here you go.\n${body}\nHope that helps.`;

  it("reads the JSON however the model dressed it", () => {
    const got = parseDifferences(
      reply(
        '{"differences":[{"kind":"text","severity":"high","what":"team name is left aligned","box":[10,20,40,30]}]}',
      ),
    );
    expect(got).toEqual([
      { kind: "text", severity: "high", what: "team name is left aligned", box: [10, 20, 40, 30] },
    ]);
  });

  it("fills in what a reply leaves out, and drops what is not a difference", () => {
    const got = parseDifferences(
      '{"differences":[{"what":"background missing","box":[0,0,100,100]},{"nonsense":true},{"what":"no box"}]}',
    );
    expect(got).toEqual([
      { kind: "other", severity: "medium", what: "background missing", box: [0, 0, 100, 100] },
    ]);
  });

  it("says nothing for a reply it cannot use", () => {
    expect(parseDifferences("They look the same to me.")).toEqual([]);
    expect(parseDifferences("{ not json }")).toEqual([]);
    expect(parseDifferences('{"differences":[]}')).toEqual([]);
    expect(parseDifferences('{"differences":"none"}')).toEqual([]);
  });
});

describe("tilesOf", () => {
  it("leaves a narrow, short frame as one tile", () => {
    expect(tilesOf({ w: 600, h: 400 })).toEqual([{ x: 0, y: 0, w: 600, h: 400 }]);
  });

  it("cuts a wide frame into columns so each pane stays readable", () => {
    const tiles = tilesOf({ w: 926, h: 469 });
    expect(tiles).toEqual([
      { x: 0, y: 0, w: 463, h: 469 },
      { x: 463, y: 0, w: 463, h: 469 },
    ]);
  });

  it("covers a tall frame exactly, once, without more tiles than allowed", () => {
    const frame = { w: 1366, h: 3540 };
    const tiles = tilesOf(frame);
    expect(tiles.length).toBeLessThanOrEqual(12);
    expect(tiles.reduce((sum, t) => sum + t.w * t.h, 0)).toBe(frame.w * frame.h);
    expect(Math.max(...tiles.map((t) => t.w))).toBeLessThanOrEqual(780);
  });

  it("never makes more tiles than allowed, however tall", () => {
    expect(tilesOf({ w: 1366, h: 40000 }).length).toBeLessThanOrEqual(12);
  });
});

describe("scaleFor", () => {
  it("doubles a tile only when the doubled pane still fits", () => {
    expect(scaleFor({ w: 463 })).toBe(2);
    expect(scaleFor({ w: 683 })).toBe(1);
    expect(scaleFor({ w: 780 })).toBe(1);
  });
});

describe("clampRegion", () => {
  const frame = { w: 926, h: 469 };

  it("leaves a region that is inside the frame", () => {
    expect(clampRegion({ x: 10, y: 20, w: 300, h: 200 }, frame)).toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 200,
    });
  });

  it("cuts a region that runs past the frame to the part that is in it", () => {
    // findings are placed by the region, so it has to be the part that is actually shown
    expect(clampRegion({ x: 900, y: 0, w: 400, h: 300 }, frame)).toEqual({
      x: 900,
      y: 0,
      w: 26,
      h: 300,
    });
    expect(clampRegion({ x: -50, y: -10, w: 100, h: 100 }, frame)).toEqual({
      x: 0,
      y: 0,
      w: 50,
      h: 90,
    });
  });

  it("says so, as the caller's mistake, for a region with nothing of the frame in it", () => {
    expect(() => clampRegion({ x: 0, y: 5000, w: 500, h: 500 }, frame)).toThrow(LookInputError);
    expect(() => clampRegion({ x: 2000, y: 0, w: 100, h: 100 }, frame)).toThrow(
      /Pass a region inside the frame/,
    );
    expect(() => clampRegion({ x: 10, y: 10, w: 2, h: 2 }, frame)).toThrow(LookInputError);
  });
});

describe("toFrameBox", () => {
  it("turns a box in percent of a band into pixels of the frame", () => {
    expect(toFrameBox([10, 50, 30, 100], { x: 0, y: 600, w: 1000, h: 400 })).toEqual({
      x: 100,
      y: 800,
      w: 200,
      h: 200,
    });
  });

  it("clamps a box that runs off its band, and takes corners in either order", () => {
    expect(toFrameBox([-20, 0, 120, 50], { x: 0, y: 0, w: 100, h: 100 })).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 50,
    });
    expect(toFrameBox([40, 40, 20, 20], { x: 0, y: 0, w: 100, h: 100 })).toEqual({
      x: 20,
      y: 20,
      w: 20,
      h: 20,
    });
  });
});

describe("nodesAt", () => {
  const nodes = [
    { id: "root", src: "1:1", type: "Overlay" },
    { id: "card", src: "1:2", type: "Stack" },
    { id: "name", src: "1:3", type: "Text" },
  ];
  const boxes = [
    { id: "root", x: 0, y: 0, w: 1000, h: 500 },
    { id: "card", x: 100, y: 100, w: 400, h: 200 },
    { id: "name", x: 120, y: 110, w: 100, h: 20 },
  ];

  it("names the layers under a place, smallest first", () => {
    const got = nodesAt({ x: 130, y: 112, w: 60, h: 12 }, boxes, nodes, (src) => `layer ${src}`);
    expect(got.map((n) => n.src)).toEqual(["1:3", "1:2", "1:1"]);
    expect(got[0]).toEqual({ src: "1:3", type: "Text", name: "layer 1:3" });
  });

  it("is just the root where nothing else is", () => {
    expect(
      nodesAt({ x: 800, y: 400, w: 10, h: 10 }, boxes, nodes, String).map((n) => n.src),
    ).toEqual(["1:1"]);
  });
});

describe("unpaintedLayers", () => {
  const theme = {
    tokens: { t: { gradient: { light: { gradient_prim_sec_horiz_1_gradient: {} } } } },
  };
  const layer = (id: string, w: number, h: number, fill: unknown, extra: object = {}) => ({
    id,
    name: id,
    type: "FRAME",
    geometry: { bbox: { x: 0, y: 0, w, h } },
    fill,
    opacity: 1,
    ...extra,
  });
  const bundleOf = (list: ReturnType<typeof layer>[]) =>
    ({
      doc: { root: list[0] },
      byId: new Map(list.map((n) => [n.id, n])),
    }) as unknown as Bundle;
  const tree = (
    nodes: Array<{ src: string; type: string; parent: string | null; props?: object }>,
  ) =>
    ({
      schemaVersion: "1",
      nodes: nodes.map((n, i) => ({ id: `n${i}`, idx: 0, props: {}, ...n })),
    }) as never;

  it("finds the root's gradient that compiled to no surface, and the token its style names", () => {
    const root = layer("root", 926, 469, {
      styleRef: "gradient/prim/prim_sec_horiz_1",
      unbound: false,
    });
    const got = unpaintedLayers(
      bundleOf([root]),
      tree([{ src: "root", type: "Overlay", parent: null }]),
      theme,
    );
    expect(got).toEqual([
      {
        src: "root",
        name: "root",
        paint: "gradient/prim/prim_sec_horiz_1",
        token: "gradient.prim_sec_horiz_1",
      },
    ]);
  });

  it("says nothing about a layer that does paint, has no fill, or is a sliver", () => {
    const root = layer("root", 926, 469, null);
    const painted = layer("painted", 500, 200, { tokenRef: "color.a", unbound: false });
    const sliver = layer("sliver", 10, 4, { tokenRef: "color.b", unbound: false });
    const photo = layer("photo", 500, 200, { raw: "IMAGE:FILL", unbound: true });
    const got = unpaintedLayers(
      bundleOf([root, painted, sliver, photo]),
      tree([
        { src: "root", type: "Overlay", parent: null },
        { src: "painted", type: "Stack", parent: "n0", props: { surface: "surface.x" } },
        { src: "sliver", type: "Box", parent: "n0" },
        { src: "photo", type: "Box", parent: "n0" },
      ]),
      theme,
    );
    expect(got).toEqual([]);
  });

  it("offers no token when the style's name points at none", () => {
    const root = layer("root", 926, 469, {
      styleRef: "gradient/prim/not_in_theme",
      unbound: false,
    });
    const [got] = unpaintedLayers(
      bundleOf([root]),
      tree([{ src: "root", type: "Overlay", parent: null }]),
      theme,
    );
    expect(got?.token).toBeUndefined();
  });
});
