import { describe, expect, it } from "vitest";
import { ART_PLATE_PREFIX, MAX_ART_PLATES, artPlateName, selectArtPlates } from "../src/art-plates";
import type { FrameIRNode } from "../src/ir/schema";
import { looseText, node, resetIds } from "./health-fixtures";

const sized = (spec: Parameters<typeof node>[0]) => node(spec);
const photo = (id: string, w = 200, h = 150) => {
  const n = sized({ id, name: `photo ${id}`, type: "IMAGE", width: w, height: h });
  n.image = { fit: "FILL", hasImageFill: true };
  return n;
};
const path = (id: string, w = 24, h = 24) => sized({ id, name: `path ${id}`, type: "VECTOR", width: w, height: h });
const mask = (id: string) => {
  const n = sized({ id, name: "Mask", type: "VECTOR", width: 100, height: 60 });
  n.isMask = true;
  return n;
};
const ids = (root: FrameIRNode, opts?: Parameters<typeof selectArtPlates>[1]) =>
  selectArtPlates(root, opts).picks.map((p) => `${p.kind}:${p.id}`);

describe("selectArtPlates", () => {
  it("always includes the root, which no section picture holds with its own fill", () => {
    resetIds();
    expect(ids(node({ id: "r", children: [] }))).toEqual(["root:r"]);
  });

  it("picks a layer that contains a mask, and nothing inside it", () => {
    resetIds();
    const group = node({
      id: "g",
      name: "Mask group",
      type: "GROUP",
      children: [mask("m"), photo("p-inside"), path("v-inside")],
    });
    const root = node({ id: "r", children: [group] });
    expect(ids(root)).toEqual(["root:r", "mask:g"]);
  });

  it("picks an image layer with no text, and not one that holds text", () => {
    resetIds();
    const withText = photo("card", 300, 200);
    withText.children = [node({ id: "t", type: "TEXT", text: looseText() })];
    const root = node({ id: "r", children: [photo("hero"), withText] });
    expect(ids(root)).toEqual(["root:r", "image:hero"]);
  });

  it("picks the largest subtree of nothing but paths, once, not each path", () => {
    resetIds();
    const crest = node({
      id: "crest",
      name: "Crest",
      type: "GROUP",
      width: 80,
      height: 80,
      children: [path("a", 80, 40), path("b", 80, 40), path("c", 30, 30)],
    });
    expect(ids(node({ id: "r", children: [crest] }))).toEqual(["root:r", "vector:crest"]);
  });

  it("leaves out rules and dots, which compile as a Divider or nothing", () => {
    resetIds();
    const rule = path("rule", 552, 1);
    const dot = path("dot", 4, 4);
    expect(ids(node({ id: "r", children: [rule, dot] }))).toEqual(["root:r"]);
  });

  it("leaves out what is already a section picture", () => {
    resetIds();
    const root = node({ id: "r", children: [photo("hero"), photo("other")] });
    expect(ids(root, { skip: new Set(["hero"]) })).toEqual(["root:r", "image:other"]);
  });

  it("orders by what is hardest to get otherwise: masks, then images, then vectors, big first", () => {
    resetIds();
    const root = node({
      id: "r",
      children: [
        path("small-v", 20, 20),
        photo("small-i", 50, 50),
        photo("big-i", 400, 300),
        node({ id: "g", type: "GROUP", children: [mask("m")] }),
        path("big-v", 90, 90),
      ],
    });
    expect(ids(root)).toEqual([
      "root:r",
      "mask:g",
      "image:big-i",
      "image:small-i",
      "vector:big-v",
      "vector:small-v",
    ]);
  });

  it("caps the count and says how many qualified", () => {
    resetIds();
    const kids = Array.from({ length: 10 }, (_, i) => photo(`p${i}`, 100 + i, 100));
    const got = selectArtPlates(node({ id: "r", children: kids }), { max: 4 });
    expect(got.picks).toHaveLength(4);
    expect(got.picks[0]?.kind).toBe("root");
    expect(got.candidates).toBe(11);
    expect(MAX_ART_PLATES).toBeGreaterThan(20);
  });

  it("ignores an invisible layer", () => {
    resetIds();
    const ghost = photo("ghost");
    ghost.opacity = 0;
    expect(ids(node({ id: "r", children: [ghost] }))).toEqual(["root:r"]);
  });
});

describe("artPlateName", () => {
  it("says the kind first and encodes the id the way Figma's URLs do", () => {
    const name = artPlateName({ id: "I35:10530;1:2", name: "x", kind: "mask", w: 1, h: 1 }, "Mask-group");
    expect(name).toBe("art-mask-Mask-group-I35-10530;1-2.png");
    expect(name.startsWith(ART_PLATE_PREFIX)).toBe(true);
  });
});
