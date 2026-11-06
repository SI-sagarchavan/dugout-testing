import { describe, expect, it } from "vitest";
import { meaningfulName, summarize } from "../src/index.ts";
import { card, node } from "./fixtures.ts";

describe("summarize", () => {
  it("counts what repeats and names the designer's layers", () => {
    const row = node(
      "FRAME",
      { x: 0, y: 0, w: 1000, h: 200 },
      {
        name: "Fixtures",
        mode: "horizontal",
        children: [card(0, 0), card(320, 0), card(640, 0)],
      },
    );
    expect(summarize(row)).toBe(
      "1000×200; 6 texts, 3 images, 3 icons; row 'Fixtures' [3× column 'Match Card' [image, 2× text, icon]]",
    );
  });

  it("says the same of two sections showing different things", () => {
    const a = node(
      "FRAME",
      { x: 0, y: 0, w: 300, h: 200 },
      { name: "Card", mode: "vertical", children: [card(0, 0)] },
    );
    const b = node(
      "FRAME",
      { x: 0, y: 0, w: 300, h: 200 },
      { name: "Card", mode: "vertical", children: [card(0, 0)] },
    );
    (b.children?.[0]?.children?.[1] as { name: string }).name = "Arsenal 2 - 1 Chelsea";
    expect(summarize(a)).toBe(summarize(b));
  });

  it("never shows a text layer's name or Figma's default names", () => {
    expect(
      meaningfulName(node("TEXT", { x: 0, y: 0, w: 1, h: 1 }, { name: "Tickets" })),
    ).toBeUndefined();
    expect(
      meaningfulName(node("FRAME", { x: 0, y: 0, w: 1, h: 1 }, { name: "Frame 1984079082" })),
    ).toBeUndefined();
    expect(
      meaningfulName(node("FRAME", { x: 0, y: 0, w: 1, h: 1 }, { name: "Auto layout" })),
    ).toBeUndefined();
    expect(meaningfulName(node("FRAME", { x: 0, y: 0, w: 1, h: 1 }, { name: "Hero" }))).toBe(
      "Hero",
    );
  });

  it("describes a container drawn on a picture as one", () => {
    const hero = node(
      "FRAME",
      { x: 0, y: 0, w: 1440, h: 600 },
      {
        name: "Hero",
        mode: "vertical",
        image: true,
        children: [node("TEXT", { x: 0, y: 0, w: 400, h: 60 })],
      },
    );
    expect(summarize(hero)).toBe("1440×600; 1 text, 1 image; column 'Hero' on an image [text]");
  });
});
