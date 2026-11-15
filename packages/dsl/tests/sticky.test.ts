/**
 * `sticky`: a node that stays at an edge of the page while the rest scrolls, inside its parent's box.
 * S20 refuses what would never stick: a node in a Carousel's slides, or one pinned by an anchor.
 */
import { describe, expect, it } from "vitest";
import type { FlatTree } from "../src/flat.js";
import { panelOf, propIssues } from "../src/index.js";
import { issuesByCode, validate } from "../src/validate.js";
import { registry } from "./helpers.js";

/** An article and a side panel in one row; the root clips, as a Figma frame does. */
function page(panel: Record<string, unknown> = { sticky: {} }): FlatTree {
  return {
    schemaVersion: "1",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row", clip: true } },
      { id: "article", parent: "root", idx: 0, type: "Stack", src: "1:2", props: {} },
      { id: "body", parent: "article", idx: 0, type: "Text", src: "1:3", props: { content: "Body", style: "type.body_sm_bold" } },
      { id: "panel", parent: "root", idx: 1, type: "Stack", src: "1:4", props: panel },
    ],
  } as unknown as FlatTree;
}

const run = (tree: FlatTree) => validate(tree, { registry: registry() });
const s20 = (tree: FlatTree) => issuesByCode(run(tree), "S20");

describe("sticky", () => {
  it("passes a side panel sticky inside a row that clips: the renderer clips it so it still sticks", () => {
    const result = run(page({ sticky: { edge: "top", offset: "space.4" } }));
    expect(result.errors).toEqual([]);
  });

  it("passes a sticky root: the whole section sticks to the page", () => {
    const tree = page({});
    tree.nodes[0]!.props = { ...tree.nodes[0]!.props, sticky: {} };
    expect(run(tree).errors).toEqual([]);
  });

  it("refuses a node sticky in a Carousel's slides", () => {
    const tree = page({});
    tree.nodes.push(
      { id: "strip", parent: "root", idx: 2, type: "Carousel", src: "1:5", props: { slidesPerView: 1 } },
      { id: "slide", parent: "strip", idx: 0, type: "Stack", src: "1:6", props: {} },
      { id: "chip", parent: "slide", idx: 0, type: "Text", src: "1:7", props: { content: "LIVE", style: "type.body_sm_bold", sticky: {} } },
    );
    expect(s20(tree).map((i) => [i.nodeId, i.path])).toEqual([["chip", "sticky"]]);
  });

  it("passes a node sticky in a box that scrolls, even when the box is in a Carousel", () => {
    const tree = page({});
    tree.nodes.push(
      { id: "strip", parent: "root", idx: 2, type: "Carousel", src: "1:5", props: { slidesPerView: 1 } },
      { id: "list", parent: "strip", idx: 0, type: "Stack", src: "1:6", props: { scroll: "y", size: { h: "space.64" } } },
      { id: "head", parent: "list", idx: 0, type: "Text", src: "1:7", props: { content: "A", style: "type.body_sm_bold", sticky: {} } },
    );
    expect(s20(tree)).toEqual([]);
  });

  it("refuses a node pinned by place.anchor and sticky at once", () => {
    const tree: FlatTree = {
      schemaVersion: "1",
      nodes: [
        { id: "hero", parent: null, idx: 0, type: "Overlay", src: "1:1", props: { size: { h: "space.64" } } },
        { id: "bar", parent: "hero", idx: 0, type: "Stack", src: "1:2", props: { place: { anchor: "top-start" }, sticky: {} } },
      ],
    } as unknown as FlatTree;
    expect(s20(tree).map((i) => i.nodeId)).toEqual(["bar"]);
  });

  it("is not a Repeater's: a fragment has no box to stick (S5)", () => {
    const tree: FlatTree = {
      schemaVersion: "1",
      nodes: [
        { id: "list", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
        { id: "rows", parent: "list", idx: 0, type: "Repeater", src: "1:2", props: { over: "items", as: "item", sticky: {} } },
        { id: "row", parent: "rows", idx: 0, type: "Text", src: "1:3", props: { content: "{item.name}", style: "type.body_sm_bold" } },
      ],
    } as unknown as FlatTree;
    expect(issuesByCode(run(tree), "S5").map((i) => i.path)).toContain("sticky");
  });

  it("takes an edge of top or bottom and a space offset, nothing else", () => {
    expect(propIssues("Stack", { sticky: { edge: "bottom", offset: "space.2" } })).toEqual([]);
    expect(propIssues("Stack", { sticky: { edge: "left" } })).not.toEqual([]);
  });

  it("is edited in the panel's Position group", () => {
    const place = panelOf("Box").find((g) => g.id === "place");
    expect(place?.fields.map((f) => f.path)).toEqual(expect.arrayContaining(["sticky.edge", "sticky.offset"]));
  });
});
