import { describe, expect, it } from "vitest";
import { findSlots, type IrNode } from "../src/index.ts";
import { doc, node } from "./fixtures.ts";

const W = 1000;
const frame = (children: IrNode[], h = 1200) =>
  doc(node("FRAME", { x: 0, y: 0, w: W, h }, { id: "0:root", children }));
const text = (id: string, y: number, w = 200, characters = "words", size = 16) => {
  const t = node("TEXT", { x: 40, y, w, h: 20 }, { id });
  t.text = { characters, fontSize: size };
  return t;
};
/** A heading row: wide, short, with words in it. */
const heading = (id: string, y: number, words: string) =>
  node(
    "FRAME",
    { x: 40, y, w: 900, h: 40 },
    { id, children: [text(`${id}t`, y + 10, 300, words, 24)] },
  );
/** A block of content: tall, no words that look like a heading. */
const content = (id: string, y: number, h = 300) =>
  node(
    "FRAME",
    { x: 40, y, w: 900, h },
    {
      id,
      children: [
        node("IMAGE", { x: 40, y, w: 300, h: h - 40 }),
        node("TEXT", { x: 400, y: y + h - 30, w: 200, h: 20 }),
      ],
    },
  );
const slotsOf = (found: ReturnType<typeof findSlots>) =>
  found.bands.flatMap((b) => b.slots.map((s) => s.nodes));

describe("findSlots", () => {
  it("reports parts it joined for sitting side by side, and keeps a pair apart when told", () => {
    const card = (id: string, x: number) =>
      node(
        "FRAME",
        { x, y: 60, w: 280, h: 300 },
        {
          id,
          children: [
            node("IMAGE", { x, y: 60, w: 280, h: 200 }),
            node("TEXT", { x, y: 300, w: 200, h: 20 }),
          ],
        },
      );
    const cards = [card("a", 40), card("b", 360), card("c", 680)];
    const joined = findSlots(frame([heading("h", 0, "Fixtures"), ...cards]));
    expect(slotsOf(joined)).toEqual([["h", "a", "b", "c"]]);
    const slot = joined.bands[0]?.slots[0];
    expect(slot?.joined).toEqual([
      ["h", "b"],
      ["b", "c"],
    ]);
    const kept = findSlots(frame([heading("h", 0, "Fixtures"), ...cards]), {
      apart: [["b", "c"]],
    });
    expect(slotsOf(kept)).toEqual([["h", "a", "b"], ["c"]]);
  });

  it("takes a full-width layer of only pictures, even wrapped, as the background", () => {
    const art = node(
      "GROUP",
      { x: 0, y: 0, w: W, h: 600 },
      {
        id: "bg",
        children: [
          node(
            "GROUP",
            { x: 0, y: 0, w: W, h: 600 },
            {
              children: [
                node("VECTOR", { x: 0, y: 0, w: W, h: 600 }),
                node("IMAGE", { x: 0, y: 0, w: 500, h: 600 }),
              ],
            },
          ),
        ],
      },
    );
    const found = findSlots(frame([art, heading("h", 100, "A"), content("c", 160)]));
    expect(found.background).toEqual(["bg"]);
    expect(slotsOf(found)).toEqual([["h", "c"]]);
    expect(found.bands[0]?.background).toEqual(["bg"]);
  });

  it("does not take a full-width layer with words in it as background", () => {
    const found = findSlots(frame([content("a", 0), content("b", 400)]));
    expect(found.background).toEqual([]);
  });

  it("joins a heading to the content under it", () => {
    const found = findSlots(
      frame([
        heading("h1", 0, "One"),
        content("c1", 60),
        heading("h2", 400, "Two"),
        content("c2", 460),
      ]),
    );
    expect(slotsOf(found)).toEqual([
      ["h1", "c1"],
      ["h2", "c2"],
    ]);
    expect(found.bands.map((b) => b.slots[0]?.name)).toEqual(["one", "two"]);
  });

  it("joins a control to the slot whose range holds it, else the closest", () => {
    const arrows = node(
      "FRAME",
      { x: 800, y: 380, w: 96, h: 40 },
      { id: "arrows", children: [text("at", 385)] },
    );
    const found = findSlots(
      frame([
        heading("h1", 0, "One"),
        content("c1", 60),
        arrows,
        heading("h2", 600, "Two"),
        content("c2", 660),
      ]),
    );
    expect(slotsOf(found)).toEqual([
      ["h1", "c1", "arrows"],
      ["h2", "c2"],
    ]);
  });

  it("keeps a layer the designer grouped, heading and content, as one slot", () => {
    const grouped = node(
      "GROUP",
      { x: 40, y: 0, w: 900, h: 400 },
      {
        id: "g",
        children: [heading("gh", 0, "Fixtures"), content("gc", 60)],
      },
    );
    const found = findSlots(frame([grouped, heading("h2", 500, "Squad"), content("c2", 560)]));
    expect(slotsOf(found)).toEqual([["g"], ["h2", "c2"]]);
    expect(found.bands.map((b) => b.slots[0]?.heading)).toEqual([true, true]);
  });

  it("puts slots under one background in one band, and others in bands of their own", () => {
    const back = node("IMAGE", { x: 0, y: 0, w: W, h: 700 }, { id: "bg" });
    const found = findSlots(
      frame([
        back,
        heading("h1", 20, "One"),
        content("c1", 80, 250),
        heading("h2", 350, "Two"),
        content("c2", 410, 250),
        heading("h3", 800, "Three"),
        content("c3", 860),
      ]),
    );
    expect(found.bands.map((b) => b.slots.map((s) => s.id))).toEqual([["h1", "h2"], ["h3"]]);
    expect(found.bands.map((b) => b.background)).toEqual([["bg"], []]);
  });

  it("names a slot from its biggest words, else its layer", () => {
    const row = node(
      "FRAME",
      { x: 40, y: 0, w: 900, h: 40 },
      {
        id: "h",
        children: [
          text("small", 5, 80, "View more", 12),
          text("big", 12, 300, "THE BRAVE SQUAD", 24),
        ],
      },
    );
    const found = findSlots(
      frame([
        row,
        content("c", 60),
        node(
          "FRAME",
          { x: 40, y: 500, w: 900, h: 200 },
          {
            id: "plain",
            name: "Latest News",
            children: [node("INSTANCE", { x: 40, y: 500, w: 100, h: 100 })],
          },
        ),
      ]),
    );
    expect(found.bands.map((b) => b.slots[0]?.name)).toEqual(["the-brave-squad", "latest-news"]);
  });

  it("is unsure of two contents with no heading between them, and of a heading alone", () => {
    const two = findSlots(frame([content("a", 0), content("b", 400)]));
    expect(two.bands.flatMap((b) => b.slots.map((s) => s.confidence))).toEqual([
      "unsure",
      "unsure",
    ]);
    expect(two.bands[0]?.slots[0]?.why).toMatch(/no heading between/);
    const alone = findSlots(
      frame([heading("h1", 0, "One"), content("c1", 60), heading("h2", 500, "Two")]),
    );
    expect(alone.bands.map((b) => b.slots[0]?.confidence)).toEqual(["sure", "unsure"]);
    expect(alone.bands[1]?.slots[0]?.why).toMatch(/no content/);
  });

  it("is sure of one content with no heading", () => {
    const found = findSlots(frame([content("a", 0)]));
    expect(found.bands.flatMap((b) => b.slots.map((s) => s.confidence))).toEqual(["sure"]);
  });

  it("takes side-by-side layers as one slot", () => {
    const row = ["a", "b", "c"].map((id, i) =>
      node(
        "FRAME",
        { x: 40 + i * 300, y: 60, w: 280, h: 300 },
        { id, children: [node("IMAGE", { x: 0, y: 60, w: 280, h: 200 })] },
      ),
    );
    const found = findSlots(frame([heading("h", 0, "Cards"), ...row]));
    expect(slotsOf(found)).toEqual([["h", "a", "b", "c"]]);
  });

  it("names the layout of the container inside a slot", () => {
    const found = findSlots(frame([heading("h", 0, "One"), content("c", 60)]), {
      layouts: [{ src: "c", kind: "carousel" }],
    });
    expect(found.bands[0]?.slots[0]?.layout).toBe("carousel");
  });

  it("takes a frame with nothing to split as one slot", () => {
    const found = findSlots(frame([node("TEXT", { x: 0, y: 0, w: 50, h: 20 }, { id: "t" })]));
    expect(slotsOf(found)).toEqual([["0:root"]]);
  });
});

describe("a designer's marks (ticket 03)", () => {
  const named = (n: IrNode, name: string) => Object.assign(n, { name });

  it("makes layers marked with one section name one section, named as marked, and sure", () => {
    // two content blocks with no heading between them would be unsure; marked alike they are one
    const found = findSlots(
      frame([
        named(content("a", 100), "section/Squad"),
        named(content("b", 420), "section/squad"),
        content("c", 760),
      ]),
    );
    expect(slotsOf(found)).toEqual([["a", "b"], ["c"]]);
    const [squad] = found.bands.flatMap((b) => b.slots);
    expect(squad).toMatchObject({ name: "squad", confidence: "sure" });
  });

  it("reads a section or background note on a layer the same as its name", () => {
    const d = frame([content("a", 100), content("b", 420), content("c", 760)]);
    d.annotations = [
      { targetId: "a", kind: "background", text: "the pattern" },
      { targetId: "b", kind: "section", text: "Fixtures" },
      { targetId: "c", kind: "must-do", text: "keep it" },
    ];
    const found = findSlots(d);
    expect(found.background).toEqual(["a"]);
    expect(found.bands.flatMap((b) => b.slots).map((s) => s.name)).toContain("fixtures");
  });

  it("takes a mark on a layer inside a child as a mark on that child", () => {
    const inner = content("b", 420);
    named((inner.children ?? [])[0] as IrNode, "section/cards");
    const found = findSlots(frame([content("a", 100), inner]));
    expect(found.bands.flatMap((b) => b.slots).find((s) => s.nodes.includes("b"))).toMatchObject({
      name: "cards",
      confidence: "sure",
    });
  });

  it("keeps no mark on a child marked two ways, and lets the rules decide it", () => {
    const d = frame([heading("h", 100, "A"), named(content("c", 160), "section/one")]);
    d.annotations = [{ targetId: "c", kind: "background", text: "x" }];
    const found = findSlots(d);
    expect(found.background).toEqual([]);
    expect(slotsOf(found)).toEqual([["h", "c"]]);
  });
});
