/**
 * A layer Figma keeps in view while its frame scrolls (IR 1.14.0) compiles to `sticky`: Figma's
 * sticky stays at the top at 0, a fixed layer where it is drawn. A layer placed by an anchor cannot
 * stick, and a note says so.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { validate } from "@fanos/dsl";
import { parseFrameIRDocument, type FrameIRDocument, type FrameIRNode } from "@fanos/surface-canvas/ir";
import { compile } from "../src/compile.js";
import { sticky } from "../src/props.js";

const irDir = new URL("../../conform/fixtures/ir/", import.meta.url).pathname;
const theme = loadTheme(new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname);
const surfaces = loadSurfaces(new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname);
const ir = (name: string): FrameIRDocument =>
  parseFrameIRDocument(JSON.parse(readFileSync(`${irDir}${name}.ir.json`, "utf8")));

/** The first frame whose parent lays it out (auto-layout), or places it (none). */
function childOf(root: FrameIRNode, laidOut: boolean): FrameIRNode | undefined {
  for (const child of root.children) {
    if (child.type === "FRAME" && (root.layout.mode !== "none") === laidOut && child.layout.positioning !== "absolute") return child;
    const deeper = childOf(child, laidOut);
    if (deeper) return deeper;
  }
  return undefined;
}

function frame(y: number, h: number): FrameIRNode {
  return { geometry: { bbox: { x: 0, y, w: 100, h } } } as unknown as FrameIRNode;
}

describe("sticky", () => {
  it("reads Figma's sticky as the top at 0", () => {
    expect(sticky(theme, { ...frame(40, 20), scroll: "sticky" }, frame(0, 400))).toEqual({});
  });

  it("keeps a fixed layer where it is drawn: the nearer edge, that far from it", () => {
    expect(sticky(theme, { ...frame(0, 60), scroll: "fixed" }, frame(0, 800))).toEqual({});
    expect(sticky(theme, { ...frame(740, 60), scroll: "fixed" }, frame(0, 800))).toEqual({ edge: "bottom" });
    const lifted = sticky(theme, { ...frame(16, 60), scroll: "fixed" }, frame(0, 800));
    expect(lifted?.offset).toBeDefined();
  });

  it("leaves a layer that scrolls with the rest", () => {
    expect(sticky(theme, frame(0, 60), frame(0, 800))).toBeUndefined();
  });

  it("compiles a sticky layer in auto-layout to a sticky node, and the tree is valid", () => {
    const doc = ir("videos-section");
    const layer = childOf(doc.root, true);
    expect(layer).toBeDefined();
    layer!.scroll = "sticky";
    const { tree } = compile(doc, { theme, surfaces });
    const node = tree.nodes.find((n) => n.src === layer!.id);
    expect(node?.props.sticky).toEqual({});
    expect(validate(tree, { registry: createRegistry(theme, { surfaces }) }).errors.filter((e) => e.code === "S20")).toEqual([]);
  });

  it("drops sticky from every layer placed by an anchor, with a note", () => {
    const doc = ir("player-card");
    const walk = (n: FrameIRNode): void => {
      for (const child of n.children) {
        child.scroll = "fixed";
        walk(child);
      }
    };
    walk(doc.root);
    const { tree, notes } = compile(doc, { theme, surfaces });
    const anchored = tree.nodes.filter((n) => (n.props.place as { anchor?: string } | undefined)?.anchor);
    expect(anchored.length).toBeGreaterThan(0);
    expect(anchored.filter((n) => n.props.sticky)).toEqual([]);
    expect(tree.nodes.some((n) => n.props.sticky)).toBe(true);
    expect(notes.filter((n) => n.kind === "sticky-dropped").length).toBeGreaterThan(0);
    expect(validate(tree, { registry: createRegistry(theme, { surfaces }) }).errors.filter((e) => e.code === "S20")).toEqual([]);
  });
});
