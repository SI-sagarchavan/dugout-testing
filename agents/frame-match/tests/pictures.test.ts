import { describe, expect, it } from "vitest";
import { type Bundle, paintedWith, pictureSource } from "../src/frame.ts";
import type { IrNode } from "../src/toolchain.ts";

const node = (
  id: string,
  type: string,
  box: [number, number, number, number],
  extra: Partial<IrNode> = {},
  children: IrNode[] = [],
): IrNode => ({
  id,
  name: id,
  type,
  geometry: { bbox: { x: box[0], y: box[1], w: box[2], h: box[3] } },
  fill: null,
  stroke: null,
  opacity: 1,
  children,
  ...extra,
});

/** The squad card of fe3e843e: a backdrop photo under the player's name and stats. */
const card = (photoPlate: boolean) => {
  const backdrop = node("backdrop", "IMAGE", [0, 0, 300, 400], { image: { hasImageFill: true } });
  const name = node("name", "TEXT", [20, 250, 260, 60]);
  const stats = node("stats", "FRAME", [10, 330, 280, 60], { fill: { raw: "#2633a8" } });
  const group = node("card", "FRAME", [0, 0, 300, 400], {}, [backdrop, name, stats]);
  const root = node("root", "FRAME", [0, 0, 1366, 1079], { clipsContent: true }, [group]);
  const all = [root, group, backdrop, name, stats];
  const parents: Array<[string, string | null]> = [
    ["root", null],
    ["card", "root"],
    ["backdrop", "card"],
    ["name", "card"],
    ["stats", "card"],
  ];
  const png = Buffer.from("");
  return {
    doc: { root, rootNodeId: "root" },
    byId: new Map(all.map((n) => [n.id, n])),
    order: new Map(all.map((n, i) => [n.id, i])),
    parents: new Map(parents),
    plates: [
      { nodeId: "root", name: "art-root-Team-root.png", png },
      { nodeId: "card", name: "Card-card.png", png },
      { nodeId: "card", name: "art-mask-Card-card.png", png },
      ...(photoPlate ? [{ nodeId: "backdrop", name: "art-image-Untitled-backdrop.png", png }] : []),
    ],
  } as unknown as Bundle;
};

describe("pictureSource", () => {
  it("takes a photo's own picture", () => {
    expect(pictureSource(card(true), "backdrop")).toBe("backdrop");
  });

  it("never cuts a photo from a picture that holds what is painted over it", () => {
    // the card's screenshot and its mask picture both hold the name and the stats bar
    const bundle = card(false);
    expect(paintedWith(bundle, "card", bundle.byId.get("backdrop") as never)).toEqual([
      "name",
      "stats",
    ]);
    expect(pictureSource(bundle, "backdrop")).toBeUndefined();
  });

  it("cuts a layer from a picture around it when nothing else paints where it shows", () => {
    const bundle = card(false);
    const crest = node("crest", "VECTOR", [400, 0, 40, 40]);
    const holder = node("holder", "FRAME", [400, 0, 40, 40], {}, [crest]);
    bundle.byId.set("crest", crest);
    bundle.byId.set("holder", holder);
    bundle.parents.set("holder", "root");
    bundle.byId.get("root")?.children?.push(holder);
    bundle.parents.set("crest", "holder");
    bundle.plates.push({ nodeId: "holder", name: "art-vector-holder.png", png: Buffer.from("") });
    expect(pictureSource(bundle, "crest")).toBe("holder");
  });

  it("cuts from a section's picture only where nothing else in it paints", () => {
    const bundle = card(false);
    // the arrows are a section of their own: each arrow is that picture's only paint where it shows
    const left = node("left", "VECTOR", [1000, 900, 40, 40]);
    const right = node("right", "VECTOR", [1056, 900, 40, 40]);
    const arrows = node("arrows", "FRAME", [1000, 900, 96, 40], {}, [left, right]);
    for (const n of [arrows, left, right]) bundle.byId.set(n.id, n);
    bundle.parents.set("arrows", "root");
    bundle.byId.get("root")?.children?.push(arrows);
    bundle.parents.set("left", "arrows");
    bundle.parents.set("right", "arrows");
    bundle.plates.push({ nodeId: "arrows", name: "Arrows-arrows.png", png: Buffer.from("") });
    expect(pictureSource(bundle, "left")).toBe("arrows");
    // the frame's picture holds the backdrop under everything, so nothing comes from it
    const backdrop = node("backdrop-band", "IMAGE", [0, 0, 1366, 1079], {
      image: { hasImageFill: true },
    });
    bundle.byId.set("backdrop-band", backdrop);
    bundle.parents.set("backdrop-band", "root");
    bundle.byId.get("root")?.children?.push(backdrop);
    bundle.plates = bundle.plates.filter((plate) => plate.nodeId !== "arrows");
    expect(pictureSource(bundle, "left")).toBeUndefined();
  });

  it("never draws a layer that holds words as a picture, even its own", () => {
    const bundle = card(false);
    expect(pictureSource(bundle, "card")).toBeUndefined();
  });
});
