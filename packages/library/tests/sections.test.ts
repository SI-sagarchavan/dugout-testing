import { describe, expect, it } from "vitest";
import { findSections, type Plate } from "../src/index.ts";
import { card, doc, node, shapeOf } from "./fixtures.ts";

const sign = shapeOf;

/** A 1440-wide page: a header, a band with a carousel of cards, and a footer. */
function page() {
  const carousel = node(
    "FRAME",
    { x: 40, y: 140, w: 1360, h: 200 },
    {
      id: "2:carousel",
      name: "Fixtures",
      mode: "horizontal",
      children: [card(40, 140), card(360, 140), card(680, 140)],
    },
  );
  const header = node(
    "FRAME",
    { x: 0, y: 0, w: 1440, h: 80 },
    {
      id: "2:header",
      mode: "horizontal",
      children: [
        node("VECTOR", { x: 20, y: 20, w: 40, h: 40 }),
        node("TEXT", { x: 80, y: 30, w: 60, h: 20 }),
      ],
    },
  );
  const band = node(
    "FRAME",
    { x: 0, y: 100, w: 1440, h: 280 },
    {
      id: "2:band",
      mode: "vertical",
      children: [node("TEXT", { x: 40, y: 100, w: 300, h: 30 }), carousel],
    },
  );
  const footer = node(
    "FRAME",
    { x: 0, y: 400, w: 1440, h: 120 },
    {
      id: "2:footer",
      mode: "vertical",
      children: [node("TEXT", { x: 40, y: 420, w: 300, h: 20 })],
    },
  );
  const badge = node(
    "FRAME",
    { x: 1300, y: 10, w: 60, h: 60 },
    { children: [node("TEXT", { x: 1300, y: 10, w: 60, h: 20 })] },
  );
  const root = node(
    "FRAME",
    { x: 0, y: 0, w: 1440, h: 520 },
    {
      id: "1:root",
      name: "Home",
      mode: "vertical",
      children: [footer, header, band, badge],
    },
  );
  return doc(root);
}

const whole: Plate = {
  nodeId: "1:root",
  name: "Home-1-root.png",
  ref: "p-root",
  width: 2880,
  height: 1040,
};

/** A plan of one part: all of `rect` of `plate`. */
const whole1 = (plate: Plate, rect: { x: number; y: number; w: number; h: number }) => ({
  width: rect.w,
  height: rect.h,
  parts: [{ plate, from: rect, to: { x: 0, y: 0, w: rect.w, h: rect.h } }],
});

describe("findSections", () => {
  it("takes a page's full-width bands in order, and the containers detection named inside them", () => {
    const { sections } = findSections(page(), {
      plates: [whole],
      layouts: [{ src: "2:carousel", kind: "carousel" }],
      sign,
    });
    expect(sections.map((s) => [s.nodeId, s.level, s.parentId, s.layout])).toEqual([
      ["2:header", 0, null, "none"],
      ["2:band", 0, null, "none"],
      ["2:carousel", 1, "2:band", "carousel"],
      ["2:footer", 0, null, "none"],
    ]);
  });

  it("cuts each section from the frame's picture at the picture's scale", () => {
    const { sections } = findSections(page(), {
      plates: [whole],
      layouts: [{ src: "2:carousel", kind: "carousel" }],
      sign,
    });
    const byId = new Map(sections.map((s) => [s.nodeId, s.crop]));
    expect(byId.get("2:band")).toEqual(whole1(whole, { x: 0, y: 200, w: 2880, h: 560 }));
    expect(byId.get("2:carousel")?.parts[0]?.from).toEqual({ x: 80, y: 280, w: 2720, h: 400 });
  });

  it("uses a section's own picture when the Handoff has one", () => {
    const own: Plate = {
      nodeId: "2:band",
      name: "band-2-band.png",
      ref: "p-band",
      width: 1440,
      height: 280,
    };
    const { sections } = findSections(page(), { plates: [whole, own], sign });
    const band = sections.find((s) => s.nodeId === "2:band");
    expect(band?.crop).toEqual(whole1(own, { x: 0, y: 0, w: 1440, h: 280 }));
  });

  it("looks through a wrapper that fills the frame", () => {
    const inner = page().root;
    const root = node(
      "FRAME",
      { x: 0, y: 0, w: 1440, h: 520 },
      { id: "0:outer", children: [inner] },
    );
    const plate = { ...whole, nodeId: "0:outer" };
    const { sections } = findSections(doc(root), { plates: [plate], sign });
    expect(sections.filter((s) => s.level === 0).map((s) => s.nodeId)).toEqual([
      "2:header",
      "2:band",
      "2:footer",
    ]);
  });

  it("takes a frame of one section as the section", () => {
    const strip = node(
      "FRAME",
      { x: 0, y: 0, w: 1200, h: 220 },
      {
        id: "3:strip",
        name: "Merchandise",
        mode: "horizontal",
        children: [card(0, 0, "Product"), node("TEXT", { x: 400, y: 0, w: 200, h: 20 })],
      },
    );
    const plate: Plate = {
      nodeId: "3:strip",
      name: "Merchandise.png",
      ref: "p",
      width: 2400,
      height: 440,
    };
    const { sections } = findSections(doc(strip), {
      plates: [plate],
      layouts: [{ src: "3:strip", kind: "row" }],
      sign,
    });
    expect(sections.map((s) => [s.nodeId, s.level, s.layout])).toEqual([["3:strip", 0, "row"]]);
    expect(sections[0]?.crop.parts[0]?.from).toEqual({ x: 0, y: 0, w: 2400, h: 440 });
  });

  it("keeps one of each shape, and says why the others were left out", () => {
    const a = node(
      "FRAME",
      { x: 0, y: 0, w: 1440, h: 200 },
      { id: "4:a", mode: "vertical", children: [card(0, 0)] },
    );
    const b = node(
      "FRAME",
      { x: 0, y: 200, w: 1440, h: 200 },
      { id: "4:b", mode: "vertical", children: [card(0, 200)] },
    );
    const root = node("FRAME", { x: 0, y: 0, w: 1440, h: 400 }, { id: "4:root", children: [a, b] });
    const plate: Plate = { nodeId: "4:root", name: "r.png", ref: "p", width: 1440, height: 400 };
    const { sections, skipped } = findSections(doc(root), { plates: [plate], sign });
    expect(sections.map((s) => s.nodeId)).toEqual(["4:a"]);
    expect(skipped).toContainEqual({
      nodeId: "4:b",
      name: b.name,
      reason: "the same shape as 4:a",
    });
  });

  it("leaves out a section no picture covers, and never cuts one from a picture of art", () => {
    const art: Plate = {
      nodeId: "1:root",
      name: "art-root-Home.png",
      ref: "a",
      width: 1440,
      height: 520,
    };
    const band: Plate = { nodeId: "2:band", name: "band.png", ref: "b", width: 1440, height: 280 };
    const { sections, skipped } = findSections(page(), { plates: [band, art], sign });
    expect(sections.map((s) => s.nodeId)).toEqual(["2:band"]);
    expect(skipped.find((s) => s.nodeId === "2:header")?.reason).toBe(
      "no picture in the Handoff covers it",
    );
  });

  it("lines a picture with a shadow up with its layer's pixels, not its layout box", () => {
    const section = node(
      "FRAME",
      { x: 0, y: 0, w: 400, h: 100 },
      {
        id: "5:s",
        renderBbox: { x: -10, y: -10, w: 420, h: 120 },
        children: [node("TEXT", { x: 10, y: 10, w: 100, h: 20 })],
      },
    );
    const plate: Plate = { nodeId: "5:s", name: "s.png", ref: "p", width: 840, height: 240 };
    const { sections } = findSections(doc(section), { plates: [plate], sign });
    expect(sections[0]?.crop.parts[0]?.from).toEqual({ x: 0, y: 0, w: 840, h: 240 });
  });

  it("puts a section's picture together from the pictures of the layers inside it", () => {
    // a header of two thin bars and a logo that hangs below it, each sent as its own picture
    const top = node(
      "FRAME",
      { x: 100, y: 50, w: 1366, h: 32 },
      {
        id: "6:top",
        mode: "horizontal",
        children: [node("TEXT", { x: 120, y: 55, w: 100, h: 20 })],
      },
    );
    const nav = node(
      "FRAME",
      { x: 100, y: 82, w: 1366, h: 44 },
      {
        id: "6:nav",
        mode: "horizontal",
        children: [node("TEXT", { x: 120, y: 90, w: 100, h: 20 })],
      },
    );
    const logo = node(
      "GROUP",
      { x: 200, y: 50, w: 84, h: 103 },
      {
        id: "6:logo",
        children: [node("VECTOR", { x: 200, y: 50, w: 84, h: 103 })],
      },
    );
    const header = node(
      "INSTANCE",
      { x: 100, y: 50, w: 1366, h: 76 },
      {
        id: "6:header",
        name: "D_Header",
        mode: "vertical",
        children: [top, nav, logo],
      },
    );
    const plates: Plate[] = [
      { nodeId: "6:top", name: "top.png", ref: "a", width: 2732, height: 64 },
      { nodeId: "6:nav", name: "nav.png", ref: "b", width: 2732, height: 88 },
      { nodeId: "6:logo", name: "logo.png", ref: "c", width: 168, height: 206 },
    ];
    const { sections, skipped } = findSections(doc(header), { plates, sign });
    expect(skipped).toEqual([]);
    expect(sections[0]?.crop).toEqual({
      width: 2732,
      height: 152,
      parts: [
        {
          plate: plates[0],
          from: { x: 0, y: 0, w: 2732, h: 64 },
          to: { x: 0, y: 0, w: 2732, h: 64 },
        },
        {
          plate: plates[1],
          from: { x: 0, y: 0, w: 2732, h: 88 },
          to: { x: 0, y: 64, w: 2732, h: 88 },
        },
        // the logo is painted last, and only the part of it inside the header
        {
          plate: plates[2],
          from: { x: 0, y: 0, w: 168, h: 152 },
          to: { x: 200, y: 0, w: 168, h: 152 },
        },
      ],
    });
  });

  it("leaves a section out when the pictures inside it cover too little of it", () => {
    const band = node(
      "FRAME",
      { x: 0, y: 0, w: 1000, h: 400 },
      {
        id: "7:band",
        children: [
          node(
            "FRAME",
            { x: 0, y: 0, w: 300, h: 100 },
            {
              id: "7:bit",
              children: [node("TEXT", { x: 0, y: 0, w: 10, h: 10 })],
            },
          ),
        ],
      },
    );
    const plates: Plate[] = [
      { nodeId: "7:bit", name: "bit.png", ref: "a", width: 300, height: 100 },
    ];
    const { skipped } = findSections(doc(band), { plates, sign });
    expect(skipped[0]?.reason).toBe(
      "no picture of it, and the pictures of layers inside it cover 8%",
    );
  });

  it("takes full-width pictures and shapes as the frame's background, not its sections", () => {
    const showcase = node(
      "FRAME",
      { x: 0, y: 0, w: 1440, h: 600 },
      {
        id: "8:showcase",
        name: "d_showcase",
        children: [
          node("IMAGE", { x: 0, y: 0, w: 1440, h: 600 }),
          node("VECTOR", { x: 0, y: 0, w: 1440, h: 600 }),
          node(
            "FRAME",
            { x: 100, y: 200, w: 600, h: 200 },
            {
              children: [node("TEXT", { x: 100, y: 200, w: 600, h: 60 })],
            },
          ),
        ],
      },
    );
    const plates: Plate[] = [
      { nodeId: "8:showcase", name: "s.png", ref: "a", width: 1440, height: 600 },
    ];
    const { sections, skipped } = findSections(doc(showcase), { plates, sign });
    expect(sections.map((s) => s.nodeId)).toEqual(["8:showcase"]);
    expect(skipped).toEqual([]);
  });
});
