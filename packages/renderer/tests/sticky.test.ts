/**
 * `sticky`: `position: sticky` at its edge, over what scrolls under it. A sticky root sticks the
 * section's wrapper, the page's child; a box that clips and holds a sticky node clips with
 * `overflow: clip`, which `hidden` would stop from sticking.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { FlatTree } from "@fanos/dsl";
import { Render } from "../src/components/Render.js";
import { CLIP_HOLDS_STICKY, resolveNode } from "../src/resolve/style.js";

const render = (tree: FlatTree) => renderToStaticMarkup(createElement(Render, { tree }));

/** The `style` attribute of the element with `data-fos-id="<id>"`. */
function styleOf(html: string, id: string): string {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*data-fos-id="${id}"[^>]*>`))?.[0] ?? "";
  return tag.match(/style="([^"]*)"/)?.[1] ?? "";
}

function page(root: Record<string, unknown>, panel: Record<string, unknown>): FlatTree {
  return {
    schemaVersion: "1",
    nodes: [
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row", ...root } },
      { id: "article", parent: "root", idx: 0, type: "Box", src: "1:2", props: {} },
      { id: "panel", parent: "root", idx: 1, type: "Stack", src: "1:3", props: panel },
    ],
  } as unknown as FlatTree;
}

describe("resolveNode: sticky", () => {
  it("sticks at the top by default, at 0, drawn over what scrolls under it", () => {
    const { style, dataAttrs } = resolveNode({ sticky: {} });
    expect(style).toMatchObject({ position: "sticky", top: "0px", zIndex: "1" });
    expect(dataAttrs["data-fos-sticky"]).toBe("top");
  });

  it("sticks at the bottom, a space token from it", () => {
    const { style } = resolveNode({ sticky: { edge: "bottom", offset: "space.4" } });
    expect(style.position).toBe("sticky");
    expect(style.bottom).toMatch(/^var\(/);
    expect(style.top).toBeUndefined();
  });

  it("leaves an anchored node absolute", () => {
    const { style } = resolveNode({ place: { anchor: "top-start" }, sticky: {} });
    expect(style.position).toBe("absolute");
  });

  it("clips a box that holds a sticky node without making it a scroll container", () => {
    const box = resolveNode({ clip: true, [CLIP_HOLDS_STICKY]: "Box" });
    expect(box.style).toMatchObject({ overflow: "clip", display: "flow-root", minWidth: "0", minHeight: "0" });
    // a Stack keeps its flex layout
    const stack = resolveNode({ clip: true, direction: "row", [CLIP_HOLDS_STICKY]: "Stack" });
    expect(stack.style).toMatchObject({ overflow: "clip", display: "flex" });
    // and every other clip is as it was
    expect(resolveNode({ clip: true }).style.overflow).toBe("hidden");
  });
});

describe("Render: sticky", () => {
  it("sticks a side panel, and clips the row that holds it with overflow: clip", () => {
    const html = render(page({ clip: true }, { sticky: { offset: "space.4" } }));
    expect(styleOf(html, "panel")).toContain("position:sticky");
    expect(styleOf(html, "root")).toContain("overflow:clip");
    expect(styleOf(html, "root")).not.toContain("overflow:hidden");
  });

  it("stops at the box that scrolls: a clip above it stays hidden", () => {
    const tree = page({ clip: true }, { scroll: "y", size: { h: "space.64" } });
    tree.nodes.push({ id: "head", parent: "panel", idx: 0, type: "Box", src: "1:4", props: { sticky: {} } } as FlatTree["nodes"][number]);
    const html = render(tree);
    expect(styleOf(html, "root")).toContain("overflow:hidden");
  });

  it("sticks the section's wrapper when the root is sticky", () => {
    const html = render(page({ sticky: {} }, {}));
    const wrapper = html.match(/<div class="fos-root"[^>]*>/)?.[0] ?? "";
    expect(wrapper).toContain('data-fos-sticky="top"');
    expect(wrapper).toMatch(/style="[^"]*position:sticky/);
  });

  it("draws nothing sticky when nothing is", () => {
    const html = render(page({ clip: true }, {}));
    expect(html).not.toContain("sticky");
    expect(styleOf(html, "root")).toContain("overflow:hidden");
  });
});
