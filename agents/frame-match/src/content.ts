/**
 * What on a section is data: whether binding it to a data source is a job at all.
 *
 * A section is three kinds of thing. Data is what changes without a designer: players, fixtures,
 * scores, headlines, photos of them. Copy is what the designer wrote and a person edits in the
 * CMS: a heading, a button's label, a tab's name. Behaviour is what a person does on the page: the
 * tab they choose (`select`, page state). Only data needs a source, so a section of copy and
 * behaviour is published as it is, with no hook to find or build.
 *
 * Code reads the signs the design gives (`signsOf`): what repeats, text that reads as data (a date,
 * a score, a long headline, a placeholder), pictures the size of a photo. When the signs settle it,
 * that is the answer; when they don't (a banner with one photo and a heading), a model reads the
 * same outline (`contentPrompt`), and what it is not sure of stays `unsure`: the binding stage
 * runs, and says itself when it finds nothing to bind.
 */

import { z } from "zod";
import type { LayoutReport } from "./layout.ts";

export const Content = z.object({
  data: z
    .enum(["none", "some", "unsure"])
    .describe(
      "none: nothing on it is data, so nothing is bound; some: it shows data; unsure: the signs do not say",
    ),
  evidence: z.array(z.string()).describe("What says so, each one sign"),
});
export type Content = z.infer<typeof Content>;

interface TreeNode {
  id: string;
  parent: string | null;
  src?: string;
  type: string;
  props: Record<string, unknown>;
}

/** At least this many px each way, a picture is a photo of something; under it, a crest or a glyph. */
const PHOTO_PX = 96;
/** Copy a designer writes is short; more words than this read as an article's headline or text. */
const PROSE_WORDS = 9;

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DAY = "(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*";
/** Text that reads as data, each with what it is. */
const DATA_TEXT: Array<[RegExp, string]> = [
  [
    /lorem ipsum|placeholder|\bplayer name\b|\bteam name\b|\bheadline\b|\btitle (goes )?here\b|\bxx+\b/i,
    "placeholder copy",
  ],
  [
    new RegExp(
      `\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b${DAY}\\b,?\\s+\\d`,
      "i",
    ),
    "a date",
  ],
  [/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, "a date"],
  [/\b\d{1,2}[:.]\d{2}\s*(am|pm|ist|gmt|bst)?\b/i, "a time"],
  [/\b\d{1,3}\s*\/\s*\d{1,2}\b|\b\d{1,3}\s*[-–]\s*\d{1,3}\b(?!\s*(years?|yrs?))/i, "a score"],
  [
    /\b\d+(\.\d+)?\s*(overs?|ov|runs|wkts?|wickets|pts|points|goals|apps|%|kg|cm|mph|km\/h)\b/i,
    "a stat",
  ],
  [/[£$€₹]\s?\d/, "a price"],
  [/\b(vs?\.?|versus)\b/i, "a fixture"],
];

/** What the design says about whether this section shows data. */
/** A Figma layer's box, by id: what a node's drawn size is read from. */
export type BoxOf = (src: string) => { w: number; h: number } | undefined;

export function signsOf(
  tree: { nodes: TreeNode[] },
  layouts: LayoutReport[],
  boxOf: BoxOf = () => undefined,
): { data: string[]; copy: string[]; unsure: string[] } {
  const data: string[] = [];
  const copy: string[] = [];
  const unsure: string[] = [];

  // What repeats is a list of things, and a list of things is data. Tabs and a menu repeat too,
  // and are the page's own: what a person chooses, where they go.
  for (const l of layouts) {
    if (l.kind === "tabs") {
      copy.push(`"${l.name}" is tabs: a choice a person makes on the page, not data`);
    } else if (l.evidence.some((e) => /named as navigation/.test(e))) {
      copy.push(`"${l.name}" is a menu`);
    } else {
      data.push(
        `"${l.name}" repeats ${l.kind === "carousel" ? "as a carousel" : `as a ${l.kind}`}: a list of things`,
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
      const hit = DATA_TEXT.find(([re]) => re.test(said));
      if (hit) {
        data.push(`"${short(said)}" reads as ${hit[1]}`);
      } else if (said.split(/\s+/).length > PROSE_WORDS) {
        data.push(
          `"${short(said)}" is ${said.split(/\s+/).length} words: an article's headline or text`,
        );
      } else if (node.type === "Button") {
        copy.push(`"${said}" is a button's label`);
      } else {
        copy.push(`"${said}" is a heading or label`);
      }
    }
    if (node.type === "Image") {
      const size = sizeOf(node.props) ?? (node.src ? rounded(boxOf(node.src)) : undefined);
      if (size && size.w >= PHOTO_PX && size.h >= PHOTO_PX) {
        unsure.push(
          `a picture ${size.w}×${size.h}px (${node.id}): a photo of something, or the design's own art`,
        );
      }
    }
  }
  return { data, copy, unsure };
}

/** The answer from the signs alone: unsure when a picture is all there is to go on. */
export function contentOf(
  tree: { nodes: TreeNode[] },
  layouts: LayoutReport[],
  boxOf?: BoxOf,
): Content {
  const signs = signsOf(tree, layouts, boxOf);
  if (signs.data.length > 0) return { data: "some", evidence: signs.data };
  if (signs.unsure.length > 0)
    return { data: "unsure", evidence: [...signs.unsure, ...signs.copy] };
  return {
    data: "none",
    evidence: signs.copy.length ? signs.copy : ["nothing on it is text, a picture or a list"],
  };
}

/** The question a model settles an unsure section by: the outline and the signs, nothing else. */
export function contentPrompt(outline: string[], content: Content): string {
  return [
    "A designer handed off one section of a sports club's website. Decide whether anything on it is DATA: content that changes without a designer, from a feed or the CMS (players, fixtures, scores, results, news headlines, photos of players or matches, dates).",
    "Not data: the section's own copy (a heading, a button's label, a tab's name), its artwork (a crest, a texture, a background, a decorative picture) and its controls.",
    "",
    "The section, one node a line:",
    ...outline.slice(0, 80),
    "",
    "What code saw:",
    ...content.evidence.map((e) => `- ${e}`),
    "",
    'Answer with one JSON object and nothing else: {"data":"none"|"some","confidence":0.0-1.0,"reason":"one short sentence"}',
  ].join("\n");
}

/** Below this, a model's answer leaves the section unsure. */
const ACCEPT = 0.8;

/** The content with a model's answer in it, when it is the JSON asked for and sure enough. */
export function applyContentVerdict(content: Content, text: string): Content {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return content;
  try {
    const v = JSON.parse(m[0]) as { data?: unknown; confidence?: unknown; reason?: unknown };
    const confidence = Number(v.confidence);
    if ((v.data !== "none" && v.data !== "some") || !Number.isFinite(confidence)) return content;
    const line = `a model judged it ${v.data === "none" ? "to show no data" : "to show data"} (${confidence.toFixed(2)})${typeof v.reason === "string" && v.reason ? `: ${v.reason}` : ""}`;
    return confidence >= ACCEPT
      ? { data: v.data, evidence: [...content.evidence, line] }
      : { ...content, evidence: [...content.evidence, line] };
  } catch {
    return content;
  }
}

/** One line a node, for the model: its type, its id and what it says. */
export function outlineOf(tree: { nodes: TreeNode[] }): string[] {
  const kids = new Map<string | null, TreeNode[]>();
  for (const n of tree.nodes) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      const said =
        typeof n.props.content === "string"
          ? ` "${short(n.props.content)}"`
          : typeof n.props.label === "string"
            ? ` [${n.props.label}]`
            : "";
      const size = n.type === "Image" ? sizeOf(n.props) : undefined;
      const extra = [size ? `${size.w}×${size.h}px` : "", n.props.select ? "tab" : ""]
        .filter(Boolean)
        .join(", ");
      lines.push(`${"  ".repeat(depth)}${n.type} ${n.id}${said}${extra ? ` (${extra})` : ""}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
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
