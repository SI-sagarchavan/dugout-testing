/**
 * Part 8 — tree operations.
 *
 * Every op must leave a tree that still reifies AND still validates. Repair
 * patches; it never regenerates, so a patch that quietly breaks the tree would
 * be discovered several iterations later with no obvious cause.
 *
 * These run against a PURPOSE-BUILT tree, not the player-card fixture. The ops
 * are generic — they know nothing about cards — and coupling them to a design
 * fixture meant every re-generation from Figma broke a dozen unrelated tests.
 * Two integration checks at the bottom still exercise the real card.
 */

import { describe, expect, it } from "vitest";
import { reify, type FlatNode, type FlatTree } from "../src/flat.js";
import {
  collapseToRepeater,
  detachAsVariant,
  insertBefore,
  insertSubtree,
  moveNode,
  removeNode,
  replaceNode,
  setProp,
  TreeOpError,
  wrapIn,
} from "../src/ops.js";
import { validate } from "../src/validate.js";
import { card, nodeOf, registry } from "./helpers.js";

const check = (tree: FlatTree) => validate(tree, { registry: registry() });

/**
 * root (Stack)
 *  ├ header (Text)
 *  └ body (Stack)          ← has children, for the cascade cases
 *     ├ left (Text)
 *     └ right (Text)
 */
function tree(): FlatTree {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      {
        id: "root",
        parent: null,
        idx: 0,
        type: "Stack",
        src: "1:1",
        props: { direction: "column", gap: "space.4", space: { px: "space.5", pb: "space.2" } },
      },
      {
        id: "header",
        parent: "root",
        idx: 0,
        type: "Text",
        src: "1:2",
        props: { content: "Header", style: "type.h3_bold", tone: "color.text_prim_high" },
      },
      { id: "body", parent: "root", idx: 1, type: "Stack", src: "1:3", props: { direction: "row", gap: "space.2" } },
      {
        id: "left",
        parent: "body",
        idx: 0,
        type: "Text",
        src: "1:4",
        props: { content: "L", style: "type.body_xs_regular" },
      },
      {
        id: "right",
        parent: "body",
        idx: 1,
        type: "Text",
        src: "1:5",
        props: { content: "R", style: "type.body_xs_regular" },
      },
    ],
  };
}

const at = (t: FlatTree, id: string) => t.nodes.find((n) => n.id === id)!;

describe("setProp", () => {
  it("sets a shallow prop without touching the input", () => {
    const before = tree();
    const after = setProp(before, "root", "gap", "space.6");
    expect(at(after, "root").props["gap"]).toBe("space.6");
    expect(at(before, "root").props["gap"]).toBe("space.4");
  });

  it("creates intermediate objects along a dotted path", () => {
    const after = setProp(tree(), "header", "space.pt", "space.2");
    expect(at(after, "header").props["space"]).toEqual({ pt: "space.2" });
  });

  it("merges into an existing nested object rather than replacing it", () => {
    const after = setProp(tree(), "root", "space.pt", "space.2");
    expect(at(after, "root").props["space"]).toEqual({ px: "space.5", pb: "space.2", pt: "space.2" });
  });

  it("leaves the tree valid", () => {
    expect(check(setProp(tree(), "root", "gap", "space.6")).ok).toBe(true);
  });

  it("errors on an unknown node", () => {
    expect(() => setProp(tree(), "ghost", "gap", "space.1")).toThrow(TreeOpError);
  });
});

describe("replaceNode", () => {
  it("keeps identity, position and src while swapping type and props", () => {
    const before = tree();
    const after = replaceNode(before, "header", {
      type: "Tag",
      props: { label: "New", variant: "solid", tone: "color.text_prim_high" },
    });
    const node = at(after, "header");
    expect(node.type).toBe("Tag");
    expect(node.parent).toBe("root");
    expect(node.idx).toBe(0);
    expect(node.src).toBe(at(before, "header").src);
    expect(check(after).ok).toBe(true);
  });
});

describe("wrapIn", () => {
  it("inserts a parent between the node and its old parent", () => {
    const after = wrapIn(tree(), "left", "Box");
    expect(at(after, "left__wrap").parent).toBe("body");
    expect(at(after, "left__wrap").idx).toBe(0);
    expect(at(after, "left").parent).toBe("left__wrap");
    expect(at(after, "left").idx).toBe(0);
  });

  it("produces a tree that still reifies and still validates", () => {
    const after = wrapIn(tree(), "left", "Box");
    expect(() => reify(after)).not.toThrow();
    expect(check(after).errors).toEqual([]);
  });

  it("marks the wrapper synthetic, pointing at what it wrapped", () => {
    const after = wrapIn(tree(), "left", "Box");
    expect(at(after, "left__wrap").src).toBe(`synthetic:${at(tree(), "left").src}:0`);
    expect(check(after).metrics.syntheticNodeCount).toBe(1);
  });

  it("does not disturb the wrapped node's siblings", () => {
    expect(at(wrapIn(tree(), "left", "Box"), "right").idx).toBe(1);
  });

  it("refuses a wrapper id that is already taken", () => {
    expect(() => wrapIn(tree(), "left", "Box", {}, "right")).toThrow(/already taken/);
  });
});

describe("insertBefore", () => {
  it("shifts the sibling and everything after it down", () => {
    const after = insertBefore(tree(), "right", {
      id: "middle",
      type: "Text",
      src: "1:9",
      props: { content: "M", style: "type.body_xs_regular" },
    });
    expect(at(after, "middle").idx).toBe(1);
    expect(at(after, "right").idx).toBe(2);
    expect(at(after, "left").idx).toBe(0);
    expect(check(after).ok).toBe(true);
  });

  it("refuses a duplicate id", () => {
    expect(() => insertBefore(tree(), "right", { id: "left", type: "Box", src: "1:9", props: {} })).toThrow(
      /already taken/,
    );
  });
});

describe("removeNode", () => {
  it("refuses to orphan children without cascade", () => {
    expect(() => removeNode(tree(), "body")).toThrow(/cascade/);
  });

  it("removes a subtree with cascade and closes the idx gap", () => {
    const after = removeNode(tree(), "body", { cascade: true });
    expect(after.nodes.map((n) => n.id).sort()).toEqual(["header", "root"]);
    expect(() => reify(after)).not.toThrow();
    expect(check(after).ok).toBe(true);
  });

  it("removes a leaf and keeps the tree contiguous", () => {
    const after = removeNode(tree(), "left");
    expect(at(after, "right").idx).toBe(0);
    expect(() => reify(after)).not.toThrow();
  });

  it("refuses to remove the root", () => {
    expect(() => removeNode(tree(), "root")).toThrow(/root/);
  });
});

describe("moveNode", () => {
  it("moves a node and keeps both parents contiguous", () => {
    const after = moveNode(tree(), "header", "body", 0);
    expect(at(after, "header").parent).toBe("body");
    expect(at(after, "header").idx).toBe(0);
    expect(at(after, "left").idx).toBe(1);
    expect(at(after, "right").idx).toBe(2);
    expect(at(after, "body").idx).toBe(0);
    expect(() => reify(after)).not.toThrow();
  });

  it("refuses to move a node into its own subtree", () => {
    expect(() => moveNode(tree(), "body", "left", 0)).toThrow(/own subtree/);
  });

  it("clamps an out-of-range index rather than opening a gap", () => {
    const after = moveNode(tree(), "header", "body", 99);
    expect(() => reify(after)).not.toThrow();
    expect(at(after, "header").idx).toBe(2);
  });
});

describe("immutability", () => {
  it("never mutates the input tree", () => {
    const before = tree();
    const snapshot = JSON.stringify(before);
    wrapIn(before, "left", "Box");
    setProp(before, "root", "gap", "space.6");
    removeNode(before, "left");
    moveNode(before, "header", "body", 0);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

/**
 * The shape a section arrives in before the repeat is recognised: three
 * instances of one card, each bound to its own index of the same array.
 *
 *   column (Stack)
 *    ├ brief_1 (Stack) ├ title_1 {section.briefs.0.headline}
 *    │                 └ date_1  {section.briefs.0.date}
 *    ├ brief_2 …0 -> 1
 *    └ brief_3 …0 -> 2
 */
function column(): FlatTree {
  const nodes: FlatNode[] = [
    { id: "column", parent: null, idx: 0, type: "Stack", src: "9:1", props: { direction: "column", gap: "space.4" } },
  ];
  for (let i = 0; i < 3; i++) {
    const n = i + 1;
    nodes.push(
      { id: `brief_${n}`, parent: "column", idx: i, type: "Stack", src: `9:1${n}`, props: { direction: "row" } },
      {
        id: `title_${n}`,
        parent: `brief_${n}`,
        idx: 0,
        type: "Text",
        src: `9:2${n}`,
        props: { content: `{section.briefs.${i}.headline}`, style: "type.body_md_bold" },
      },
      {
        id: `date_${n}`,
        parent: `brief_${n}`,
        idx: 1,
        type: "Text",
        src: `9:3${n}`,
        props: { content: `{section.briefs.${i}.date}`, style: "type.body_xs_regular" },
      },
    );
  }
  return { schemaVersion: "1.0.0", nodes };
}

describe("collapseToRepeater", () => {
  const collapse = (over = "section.briefs", as = "brief") =>
    collapseToRepeater(column(), { instances: ["brief_1", "brief_2", "brief_3"], over, as });

  it("keeps the first instance and drops the rest with their subtrees", () => {
    const after = collapse();
    expect(after.nodes.some((n) => n.id === "brief_1")).toBe(true);
    for (const gone of ["brief_2", "brief_3", "title_2", "date_3"]) {
      expect(after.nodes.some((n) => n.id === gone), `${gone} should be gone`).toBe(false);
    }
  });

  it("puts a Repeater where the instances were, holding the template", () => {
    const repeater = at(collapse(), "brief_1__repeat");
    expect(repeater.type).toBe("Repeater");
    expect(repeater.parent).toBe("column");
    expect(repeater.idx).toBe(0);
    expect(repeater.props).toEqual({ over: "section.briefs", as: "brief", limit: 3 });
    expect(at(collapse(), "brief_1").parent).toBe("brief_1__repeat");
  });

  /**
   * The whole point of the alias. One template cannot be bound to index 0 —
   * every item would render the first story.
   */
  it("re-aliases the template's index-bound paths", () => {
    const after = collapse();
    expect(at(after, "title_1").props["content"]).toBe("{brief.headline}");
    expect(at(after, "date_1").props["content"]).toBe("{brief.date}");
  });

  it("rewrites whichever index the kept instance carried", () => {
    const after = collapseToRepeater(column(), {
      instances: ["brief_2", "brief_1", "brief_3"],
      over: "section.briefs",
      as: "brief",
    });
    expect(at(after, "title_2").props["content"]).toBe("{brief.headline}");
  });

  it("leaves paths into other data alone", () => {
    const before = setProp(column(), "title_1", "content", "{section.title} — {section.briefs.0.headline}");
    const after = collapseToRepeater(before, {
      instances: ["brief_1", "brief_2", "brief_3"],
      over: "section.briefs",
      as: "brief",
    });
    expect(at(after, "title_1").props["content"]).toBe("{section.title} — {brief.headline}");
  });

  /**
   * A column laid out for three cards is not a column for ten, and the design
   * is the only thing that knows which. `null` is how a caller says otherwise.
   */
  it("limits to the number of instances the design drew, unless told not to", () => {
    expect(at(collapse(), "brief_1__repeat").props["limit"]).toBe(3);
    const unbounded = collapseToRepeater(column(), {
      instances: ["brief_1", "brief_2"],
      over: "section.briefs",
      as: "brief",
      limit: null,
    });
    expect(at(unbounded, "brief_1__repeat").props).toEqual({ over: "section.briefs", as: "brief" });
  });

  it("leaves the tree reifiable and valid", () => {
    const after = collapse();
    expect(() => reify(after)).not.toThrow();
    expect(check(after).errors).toEqual([]);
  });

  it("does not mutate the input", () => {
    const before = column();
    collapseToRepeater(before, { instances: ["brief_1", "brief_2", "brief_3"], over: "section.briefs", as: "brief" });
    expect(before.nodes).toHaveLength(10);
    expect(at(before, "title_1").props["content"]).toBe("{section.briefs.0.headline}");
  });

  it("refuses instances that are not siblings", () => {
    expect(() =>
      collapseToRepeater(column(), { instances: ["brief_1", "title_2"], over: "section.briefs", as: "brief" }),
    ).toThrow(/share a parent/);
  });

  it("refuses an alias that cannot head a data path", () => {
    expect(() => collapse("section.briefs", "brief.item")).toThrow(TreeOpError);
    expect(() => collapse("section.briefs", "")).toThrow(TreeOpError);
  });

  it("refuses a duplicate or missing instance", () => {
    expect(() =>
      collapseToRepeater(column(), { instances: ["brief_1", "brief_1"], over: "section.briefs", as: "brief" }),
    ).toThrow(/twice/);
    expect(() =>
      collapseToRepeater(column(), { instances: ["ghost"], over: "section.briefs", as: "brief" }),
    ).toThrow(TreeOpError);
  });
});

describe("against the real card", () => {
  it("patches a stat value and keeps the card valid", () => {
    const after = setProp(card(), "stat_matches_value", "tone", "color.text_sec_medium");
    expect(nodeOf(after, "stat_matches_value").props["tone"]).toBe("color.text_sec_medium");
    expect(check(after).errors).toEqual([]);
  });

  it("wrapping an Overlay child needs the wrapper to carry the anchor (S8)", () => {
    // Not a bug: every Overlay child must declare place.anchor, so a bare
    // wrapper is correctly rejected. Repair has to move `place` onto the wrapper.
    const bare = wrapIn(card(), "name", "Box");
    expect(check(bare).errors.some((e) => e.code === "S8")).toBe(true);

    const anchored = wrapIn(card(), "name", "Box", {
      place: { anchor: "top-center", offset: { block: { raw: 251, _unbound: true } } },
    });
    expect(check(anchored).errors.filter((e) => e.code === "S8")).toEqual([]);
  });
});

describe("detachAsVariant", () => {
  const listTree = (): FlatTree => ({
    schemaVersion: "1.0.0",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row" } },
      { id: "rep", parent: "root", idx: 0, type: "Repeater", src: "synthetic:1:1:0", props: { over: "players", as: "item" } },
      { id: "card", parent: "rep", idx: 0, type: "Stack", src: "1:2", props: { direction: "column" } },
      { id: "name", parent: "card", idx: 0, type: "Text", src: "1:3", props: { content: "{{item.name}}", style: "type.body_xs_regular" } },
    ],
  });

  it("gives one item its own copy, bound to the same item scope, and keeps the template off it", () => {
    const { tree: next, id } = detachAsVariant(listTree(), "card", { key: "item.id", value: 7 });
    expect(id).toBe("card__v1");
    const byId = (i: string) => next.nodes.find((n) => n.id === i)!;
    expect(byId("card").props.when).toEqual({ path: "item.id", ne: 7 });
    expect(byId("card__v1").props.when).toEqual({ path: "item.id", eq: 7 });
    expect(byId("card__v1").parent).toBe("rep");
    expect(byId("name__v1").parent).toBe("card__v1");
    expect(byId("name__v1").props.content).toBe("{{item.name}}");
    expect(() => reify(next)).not.toThrow();
  });

  it("stacks exclusions on the template and refuses a repeat or a non-item", () => {
    const first = detachAsVariant(listTree(), "card", { key: "item.id", value: 7 }).tree;
    const second = detachAsVariant(first, "card", { key: "item.id", value: 9 }).tree;
    expect(second.nodes.find((n) => n.id === "card")!.props.when).toEqual([
      { path: "item.id", ne: 7 },
      { path: "item.id", ne: 9 },
    ]);
    expect(() => detachAsVariant(second, "card", { key: "item.id", value: 7 })).toThrow(TreeOpError);
    expect(() => detachAsVariant(listTree(), "name", { key: "item.id", value: 1 })).toThrow(TreeOpError);
    expect(() => detachAsVariant(listTree(), "card", { key: "other.id", value: 1 })).toThrow(TreeOpError);
  });
});

describe("insertSubtree", () => {
  // a section from another page, as the library keeps it: its own root, ids and Figma origins
  const strip = (): FlatTree => ({
    schemaVersion: "1.0.0",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "7:1", props: { direction: "row", gap: "space.2" } },
      { id: "a", parent: "root", idx: 0, type: "Text", src: "7:2", props: { content: "A", style: "type.body_xs_regular" } },
      { id: "b", parent: "root", idx: 1, type: "Text", src: "7:3", props: { content: "B", style: "type.body_xs_regular" } },
    ],
  });

  it("puts the section under a node, ids renamed and origins synthetic, and the tree still validates", () => {
    const out = insertSubtree(tree(), strip(), { parent: "root", idx: 1 });
    expect(reify(out).children?.map((c) => c.id)).toEqual(["header", "ins1:root", "body"]);
    const under = out.nodes.filter((n) => n.parent === "ins1:root");
    expect(under.map((n) => n.id)).toEqual(["ins1:a", "ins1:b"]);
    expect(out.nodes.find((n) => n.id === "ins1:a")?.src).toBe("synthetic:inserted:7:2");
    expect(out.nodes.find((n) => n.id === "body")).toMatchObject({ parent: "root", idx: 2 });
    expect(check(out).errors).toEqual([]);
  });

  it("goes last when no place is given, and first at 0", () => {
    const last = insertSubtree(tree(), strip(), { parent: "root" });
    expect(reify(last).children?.map((c) => c.id)).toEqual(["header", "body", "ins1:root"]);
    const first = insertSubtree(tree(), strip(), { parent: "root", idx: 0 });
    expect(reify(first).children?.map((c) => c.id)).toEqual(["ins1:root", "header", "body"]);
  });

  it("keeps document order, so flatten(reify(x)) is the same list", () => {
    const out = insertSubtree(tree(), strip(), { parent: "root", idx: 1 });
    expect(out.nodes.map((n) => n.id)).toEqual([
      "root", "header", "ins1:root", "ins1:a", "ins1:b", "body", "left", "right",
    ]);
  });

  it("the same section twice gets two sets of ids", () => {
    const once = insertSubtree(tree(), strip(), { parent: "root" });
    const twice = insertSubtree(once, strip(), { parent: "root" });
    expect(twice.nodes.some((n) => n.id === "ins2:root")).toBe(true);
    expect(reify(twice).children).toHaveLength(4);
  });

  it("does not change the tree it was given, and refuses a missing parent or a second root", () => {
    const base = tree();
    const copy = JSON.stringify(base);
    insertSubtree(base, strip(), { parent: "root" });
    expect(JSON.stringify(base)).toBe(copy);
    expect(() => insertSubtree(base, strip(), { parent: "nope" })).toThrow(TreeOpError);
    const two = { ...strip(), nodes: [...strip().nodes, { id: "x", parent: null, idx: 1, type: "Text", src: "7:9", props: {} }] };
    expect(() => insertSubtree(base, two, { parent: "root" })).toThrow(/one root/);
  });
});
