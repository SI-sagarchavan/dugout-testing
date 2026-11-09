/**
 * S2 — several sections, none marked.
 *
 * PURE. No Figma import.
 *
 * A frame handed off with two or more parts that each look like a section (a fixtures strip over a
 * squad) is bound part by part, each to its own data. The agents find the parts from the layout,
 * and ask a person when they are unsure; a designer who marks them (a Section note, or a layer
 * named `section/<name>`) settles it before anyone is asked. A hint, not an error: an unmarked
 * frame still builds.
 *
 * A part is a direct child of the frame (looked through a lone wrapper) at least half its width
 * and SECTION_HEIGHT tall, with something in it other than pictures: a full-width picture is the
 * background.
 */
import { walkNodes } from "../health/slots.js";
import type { Rule } from "../health/types.js";
import type { FrameIRDocument, FrameIRNode } from "../ir/schema.js";
import { pageFinding } from "./shared.js";

const SECTION_HEIGHT = 120;
const SECTION_WIDTH = 0.5;
const WRAPPER_COVER = 0.9;

const MARKED_NAME = /^\s*(section|background)\s*(\/|$)/i;

function unwrap(root: FrameIRNode): FrameIRNode {
  let node = root;
  for (;;) {
    const only = node.children?.length === 1 ? node.children[0] : undefined;
    if (!only?.children?.length) return node;
    const area = (n: FrameIRNode) => n.geometry.bbox.w * n.geometry.bbox.h;
    if (area(only) < area(node) * WRAPPER_COVER) return node;
    node = only;
  }
}

const picturesOnly = (node: FrameIRNode): boolean =>
  node.type !== "TEXT" &&
  node.type !== "INSTANCE" &&
  node.type !== "COMPONENT" &&
  (node.children ?? []).every(picturesOnly);

function marked(ir: FrameIRDocument): boolean {
  if (walkNodes(ir.root).some((n) => MARKED_NAME.test(n.name))) return true;
  return (ir.annotations ?? []).some((a) => a.kind === "section" || a.kind === "background");
}

export function sectionParts(ir: FrameIRDocument): FrameIRNode[] {
  const frame = unwrap(ir.root);
  const width = frame.geometry.bbox.w;
  return (frame.children ?? []).filter(
    (child) =>
      child.geometry.bbox.w >= width * SECTION_WIDTH &&
      child.geometry.bbox.h >= SECTION_HEIGHT &&
      Boolean(child.children?.length) &&
      !picturesOnly(child),
  );
}

export const sectionsUnmarked: Rule = {
  id: "sections-unmarked",
  code: "S2",
  group: "structure",
  protects: "each part bound to its own data — unmarked parts are guessed from the layout",

  check(ir) {
    const parts = sectionParts(ir);
    if (parts.length < 2 || marked(ir)) return [];
    return [
      pageFinding({
        ruleId: "sections-unmarked",
        group: "structure",
        nodeId: "",
        nodeName: ir.pageName,
        propPath: "annotations",
        currentValue: "unmarked",
        message: `${parts.length} parts look like separate sections · none marked`,
        hint: "Add a Section note to each part's layers, with its name (or name the layer section/<name>), and a Background note on what sits behind them. Each section is then bound to its own data without anyone being asked.",
        detail: { parts: parts.length },
        nodeIds: parts.map((p) => p.id),
      }),
    ];
  },
};
