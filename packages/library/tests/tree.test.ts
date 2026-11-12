import { describe, expect, it } from "vitest";
import { sectionTree } from "../src/index.ts";

const node = (id: string, parent: string | null, idx: number, src: string) => ({
  id,
  parent,
  idx,
  type: "Box",
  src,
  props: { text: `text of ${id}` },
});

// page 1:1 > news 2:1 > (title I2:5, list 2:2 > card 2:3) ; footer 3:1
const page = {
  schemaVersion: "1",
  nodes: [
    node("n0", null, 0, "1:1"),
    node("n1", "n0", 0, "2:1"),
    node("n2", "n1", 0, "I2:5"),
    node("n3", "n1", 1, "2:2"),
    node("n4", "n3", 0, "2:3"),
    node("n5", "n0", 1, "3:1"),
  ],
};
const inNews = (src: string) => ["2:1", "I2:5", "2:2", "2:3"].includes(src);

describe("sectionTree", () => {
  it("is the section's node and everything under it, as a tree of its own", () => {
    const t = sectionTree(page, "2:1", inNews);
    expect(t?.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(t?.nodes[0]).toMatchObject({ parent: null, idx: 0 });
    expect(t?.nodes[1]).toMatchObject({ parent: "n1", idx: 0 });
    expect(t?.schemaVersion).toBe("1");
  });

  it("takes the topmost node drawn from the section when its own layer was left out", () => {
    const flat = { nodes: [node("n0", null, 0, "1:1"), node("n2", "n0", 0, "I2:5")] };
    expect(sectionTree(flat, "2:1", inNews)?.nodes.map((n) => n.id)).toEqual(["n2"]);
  });

  it("is nothing when no node was drawn from the section", () => {
    expect(sectionTree(page, "9:9", (s) => s === "9:9")).toBeUndefined();
    expect(sectionTree({ nothing: true }, "2:1", inNews)).toBeUndefined();
  });
});
