/**
 * What on a section is data: whether binding it to a data source is a job at all.
 *
 * A section is three kinds of thing. Data is what changes without a designer: the items of a feed,
 * the CMS's articles, numbers that change, photos of them. Copy is what the designer wrote and a
 * person edits in the CMS: a heading, a button's label, a tab's name. Behaviour is what a person does
 * on the page: the tab they choose (`select`, page state). Only data needs a source, so a section of
 * copy and behaviour is published as it is, with no hook to find or build.
 *
 * Code only reports (`signsOf`): what repeats, text shaped like a date, a time or numbers, long
 * prose, pictures the size of a photo, and the names the designer gave the layers. From those it
 * proposes an answer (`contentOf`); the agent's model settles it, with why, when it publishes
 * (`frame.publish`'s `content`), and that is what the section's `content` says.
 */

import { z } from "zod";
import type { LayoutReport } from "./layout.ts";

export const Content = z.object({
  data: z
    .enum(["none", "some", "unsure"])
    .describe(
      "none: nothing on it is data, so nothing is bound; some: it shows data; unsure: not settled (a proposal from the signs alone)",
    ),
  evidence: z.array(z.string()).describe("What says so: the agent's why first, then each sign"),
  why: z.string().optional().describe("Why the agent settled it so"),
  by: z
    .enum(["person", "memory", "agent"])
    .optional()
    .describe("Who settled it; absent while it is only the signs' proposal"),
});
export type Content = z.infer<typeof Content>;

interface TreeNode {
  id: string;
  parent: string | null;
  src?: string;
  type: string;
  props: Record<string, unknown>;
}

/** Pictures at least this many px each way are listed: a photo of something, or the design's own art. */
const PHOTO_PX = 96;
/** Texts with more words than this are listed with their length: a sentence, not a label. */
const LONG_WORDS = 9;

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const WEEKDAY = "(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*";
/** Text shaped like a value that changes, each with what shape it is. No subject's vocabulary. */
const SHAPES: Array<[RegExp, string]> = [
  [/lorem ipsum/i, "placeholder text"],
  [
    new RegExp(
      `\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b${WEEKDAY}\\b,?\\s+\\d`,
      "i",
    ),
    "a date",
  ],
  [/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, "a date"],
  [/\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i, "a time"],
  [/\b\d+\s*[-–/]\s*\d+\b/, "two numbers joined"],
];

/** A Figma layer's box, by id: what a node's drawn size is read from. */
export type BoxOf = (src: string) => { w: number; h: number } | undefined;
/** A Figma layer's name, by id. */
export type NameOf = (src: string) => string | undefined;

/** The signs, each one line with real values, grouped by which way each usually leans: for the proposal only. */
export interface Signs {
  /** Signs that usually mean data: something repeats, a value-shaped text, long prose. */
  data: string[];
  /** Signs that usually mean copy or behaviour: short labels, tabs. */
  copy: string[];
  /** Facts that lean neither way: photo-sized pictures, numbers in short text. */
  neutral: string[];
}

/** What the design shows that bears on whether the section shows data. Reports; decides nothing. */
export function signsOf(
  tree: { nodes: TreeNode[] },
  layouts: LayoutReport[],
  boxOf: BoxOf = () => undefined,
  nameOf: NameOf = () => undefined,
): Signs {
  const data: string[] = [];
  const copy: string[] = [];
  const neutral: string[] = [];

  for (const l of layouts) {
    const count = l.items?.length ?? 0;
    const items = count > 0 ? `${count} items` : "items";
    if (l.choice.kind === "tabs") {
      copy.push(`"${l.name}" is proposed as tabs: ${items}, one drawn selected`);
    } else {
      data.push(
        `"${l.name}" repeats ${items} as a ${l.choice.kind}${l.decided ? "" : ` (proposed, ${l.confidence})`}`,
      );
    }
  }

  const options = new Set(tree.nodes.filter((n) => n.props.select !== undefined).map((n) => n.id));
  const parentOf = new Map(tree.nodes.map((n) => [n.id, n.parent]));
  const inOption = (id: string) => {
    for (let at: string | null | undefined = id; at; at = parentOf.get(at))
      if (options.has(at)) return true;
    return false;
  };

  for (const node of tree.nodes) {
    const text =
      node.type === "Text"
        ? node.props.content
        : node.type === "Button"
          ? node.props.label
          : undefined;
    if (typeof text === "string" && text.trim()) {
      const said = text.trim();
      if (inOption(node.id)) continue;
      const layer = node.src ? nameOf(node.src) : undefined;
      const named = layer?.trim() && layer.trim() !== said ? ` (layer "${layer}")` : "";
      const words = said.split(/\s+/).length;
      const shape = SHAPES.find(([re]) => re.test(said));
      if (shape) data.push(`"${short(said)}"${named} is shaped like ${shape[1]}`);
      else if (words > LONG_WORDS) data.push(`"${short(said)}"${named} is ${words} words`);
      else if (/\d/.test(said)) neutral.push(`"${said}"${named} holds a number`);
      else
        copy.push(
          `"${said}"${named} is ${node.type === "Button" ? "a button's label" : "a short text"}`,
        );
    }
    if (node.type === "Image") {
      const size = sizeOf(node.props) ?? (node.src ? rounded(boxOf(node.src)) : undefined);
      if (size && size.w >= PHOTO_PX && size.h >= PHOTO_PX) {
        const layer = node.src ? nameOf(node.src) : undefined;
        neutral.push(
          `a picture ${size.w}×${size.h}px (${node.id}${layer ? `, layer "${layer}"` : ""})`,
        );
      }
    }
  }
  return { data, copy, neutral };
}

/**
 * The signs, and the answer they propose: `some` when a sign leans to data, `none` when everything
 * is short copy, `unsure` when only pictures or numbers are left to go on. A proposal: the agent
 * settles it when it publishes.
 */
export function contentOf(
  tree: { nodes: TreeNode[] },
  layouts: LayoutReport[],
  boxOf?: BoxOf,
  nameOf?: NameOf,
): Content {
  const signs = signsOf(tree, layouts, boxOf, nameOf);
  const evidence = [...signs.data, ...signs.neutral, ...signs.copy];
  if (signs.data.length > 0) return { data: "some", evidence };
  if (signs.neutral.length > 0) return { data: "unsure", evidence };
  return {
    data: "none",
    evidence: evidence.length > 0 ? evidence : ["nothing on it is text, a picture or a list"],
  };
}

/** What the agent settled, as the section's content: its why first, then the signs it read. */
export function settledContent(
  proposal: Content,
  decided: { data: "none" | "some"; why: string; by?: "person" | "memory" | "agent" | undefined },
): Content {
  return {
    data: decided.data,
    evidence: [`decided: ${decided.why}`, ...proposal.evidence],
    why: decided.why,
    by: decided.by ?? "agent",
  };
}

const rounded = (b: { w: number; h: number } | undefined) =>
  b ? { w: Math.round(b.w), h: Math.round(b.h) } : undefined;

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** A node's drawn size in px, when the tree says it. */
function sizeOf(props: Record<string, unknown>): { w: number; h: number } | undefined {
  const size = props.size as { w?: unknown; h?: unknown } | undefined;
  const px = (v: unknown): number | undefined =>
    typeof v === "number"
      ? v
      : v && typeof v === "object" && "raw" in v
        ? Number((v as { raw: unknown }).raw)
        : undefined;
  const w = px(size?.w);
  const h = px(size?.h);
  return w && h ? { w: Math.round(w), h: Math.round(h) } : undefined;
}
