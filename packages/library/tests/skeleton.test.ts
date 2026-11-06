import { describe, expect, it } from "vitest";
import { NEUTRAL_PALETTE, roleOf, skeletonOf, skeletonSvg } from "../src/index.ts";
import { card, node } from "./fixtures.ts";

describe("skeletonOf", () => {
  it("keeps the boxes and the roles of their paint, and nothing they said", () => {
    const band = node(
      "FRAME",
      { x: 100, y: 100, w: 700, h: 260 },
      {
        mode: "horizontal",
        children: [card(110, 110), card(420, 110)],
      },
    );
    band.fill = { tokenRef: "background/primary/container" };
    const first = band.children?.[0];
    if (first) {
      first.fill = { raw: "#ffffff" };
      first.radius = { value: 12 };
    }
    const sk = skeletonOf(band);
    expect(sk).toMatchObject({ w: 700, h: 260 });
    // the band is accent: drawn first, under everything
    expect(sk.shapes[0]).toEqual({
      kind: "fill",
      x: 0,
      y: 0,
      w: 700,
      h: 260,
      r: 0,
      role: "accent",
    });
    expect(sk.shapes).toContainEqual({
      kind: "fill",
      x: 10,
      y: 10,
      w: 300,
      h: 200,
      r: 12,
      role: "surface",
    });
    expect(sk.shapes.filter((s) => s.kind === "image")).toHaveLength(2);
    expect(sk.shapes.filter((s) => s.kind === "icon")).toHaveLength(2);
    // text on the white card is ink; on the bare accent band it would be on-accent
    const texts = sk.shapes.filter((s) => s.kind === "text");
    expect(texts.map((t) => t.kind === "text" && t.onAccent)).toEqual([false, false, true, true]);
    expect(JSON.stringify(sk)).not.toContain("Some words");
  });

  it("gives a raw colour the accent role when it is saturated or dark", () => {
    expect(roleOf({ raw: "#d71920" })).toBe("accent");
    expect(roleOf({ raw: "#101828" })).toBe("accent");
    expect(roleOf({ raw: "#f4f4f5" })).toBe("surface");
    expect(roleOf({ tokenRef: "neu/00" })).toBe("surface");
    expect(roleOf({ tokenRef: "brand/red" })).toBe("accent");
  });
});

describe("clipping", () => {
  it("cuts what a layer clips to its box", () => {
    const cardWithWidePhoto = node(
      "FRAME",
      { x: 0, y: 0, w: 200, h: 300 },
      {
        children: [node("IMAGE", { x: 0, y: 0, w: 900, h: 300 })],
      },
    );
    cardWithWidePhoto.clipsContent = true;
    const row = node("FRAME", { x: 0, y: 0, w: 1000, h: 300 }, { children: [cardWithWidePhoto] });
    expect(skeletonOf(row).shapes).toEqual([{ kind: "image", x: 0, y: 0, w: 200, h: 300, r: 0 }]);
    cardWithWidePhoto.clipsContent = false;
    expect(skeletonOf(row).shapes).toEqual([{ kind: "image", x: 0, y: 0, w: 900, h: 300, r: 0 }]);
  });
});

describe("skeletonSvg", () => {
  it("paints the skeleton in the viewer's colours", () => {
    const sk = skeletonOf(
      node("FRAME", { x: 0, y: 0, w: 400, h: 200 }, { children: [card(0, 0)] }),
    );
    const svg = skeletonSvg(sk, { ...NEUTRAL_PALETTE, ink: "#123456", placeholder: "#abcdef" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 400 200"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#abcdef"');
  });
});
