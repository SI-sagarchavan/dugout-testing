/**
 * A node that links (`href`): a card that opens its article, a VIEW ALL. S19 keeps it HTML: no link
 * inside a link, a Button links by its action, and only a box or a text is drawn as a link.
 */
import { describe, expect, it } from "vitest";
import type { FlatTree } from "../src/flat.js";
import { issuesByCode, validate } from "../src/validate.js";
import { registry } from "./helpers.js";

function card(): FlatTree {
  return {
    schemaVersion: "1",
    nodes: [
      { id: "card", parent: null, idx: 0, type: "Stack", src: "1:1", props: { href: "/news/{n.slug}" } },
      { id: "title", parent: "card", idx: 0, type: "Text", src: "1:2", props: { content: "{n.title}", style: "type.body_sm_bold" } },
    ],
  } as unknown as FlatTree;
}
const check = (tree: FlatTree) => issuesByCode(validate(tree, { registry: registry() }), "S19");

describe("S19", () => {
  it("passes a card that links", () => {
    expect(check(card())).toEqual([]);
  });

  it("refuses a link inside a link", () => {
    const tree = card();
    tree.nodes[1]!.props = { ...tree.nodes[1]!.props, href: "/elsewhere" };
    expect(check(tree).map((i) => i.nodeId)).toEqual(["title"]);
  });

  it("refuses href on a Button, and on a node not drawn as a link", () => {
    const tree = card();
    tree.nodes.push(
      { id: "cta", parent: "card", idx: 1, type: "Button", src: "1:3", props: { label: "GO", variant: "filled", styleN: 1, size: "md", action: { kind: "none" }, href: "/x" } },
      { id: "pic", parent: null, idx: 1, type: "Image", src: "1:4", props: { src: "", alt: "", href: "/y" } },
    );
    const nodes = check(tree).map((i) => i.nodeId);
    expect(nodes).toContain("cta");
    expect(nodes).toContain("pic");
  });
});
