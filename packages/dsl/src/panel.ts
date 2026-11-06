/**
 * The property panel of a node, derived from the field descriptors.
 *
 * A person editing a node in a preview sees what its type declares and nothing else: a Stack's
 * direction, gap and alignment, a Text's content and style, plus the universal size, space,
 * place and look. Because it is computed from the same `Fields` the validator and the agent's
 * schema are, a prop added to a node shows up in the panel with no edit here.
 *
 * Pure, and JSON-safe, so a server can build it and a browser can draw it.
 */

import { allFields, nodeSpec } from "./nodes/index.js";
import { zodOfFields } from "./field.js";
import type { Field, FieldType, Fields } from "./field.js";
import { ANCHORS } from "./values.js";
import type { PanelControl } from "./panel-values.js";

export type { PanelControl };

export interface PanelField {
  /** Dotted path into the node's `props`: `gap`, `space.px`, `size.w`. */
  path: string;
  label: string;
  control: PanelControl;
  /** Takes `{ base, md?, lg? }`; the panel edits the base. */
  resp: boolean;
  doc?: string;
}

export type PanelGroupId = "layout" | "size" | "space" | "place" | "look" | "content" | "behaviour" | "meta";

export interface PanelGroup {
  id: PanelGroupId;
  title: string;
  fields: PanelField[];
}

const GROUPS: { id: PanelGroupId; title: string }[] = [
  { id: "content", title: "Content" },
  { id: "layout", title: "Layout" },
  { id: "size", title: "Size" },
  { id: "space", title: "Spacing" },
  { id: "place", title: "Position" },
  { id: "look", title: "Appearance" },
  { id: "behaviour", title: "Behaviour" },
  { id: "meta", title: "Notes" },
];

/** Universal props, and the group each belongs to. Anything not named is `behaviour`. */
const UNIVERSAL_GROUP: Record<string, PanelGroupId> = {
  surface: "look",
  fill: "look",
  opacity: "look",
  blend: "look",
  transform: "look",
  size: "size",
  column: "size",
  space: "space",
  place: "place",
  _meta: "meta",
};

/** What a structural node declares of itself is layout; a leaf's own props are its content. */
const OWN_GROUP: Record<"structural" | "leaf", PanelGroupId> = { structural: "layout", leaf: "content" };

const LABELS: Record<string, string> = {
  w: "Width",
  h: "Height",
  minW: "Min width",
  maxW: "Max width",
  minH: "Min height",
  maxH: "Max height",
  p: "Padding",
  px: "Padding inline",
  py: "Padding block",
  pt: "Padding top",
  pr: "Padding end",
  pb: "Padding bottom",
  pl: "Padding start",
  minItemWidth: "Min item width",
  columnGap: "Column gap",
  rowGap: "Row gap",
  revealDelay: "Reveal delay",
  testId: "Test id",
};

const humanise = (name: string): string =>
  LABELS[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Props whose subtree is too structural to edit by hand here: edited through a comment instead. */
const SKIPPED = new Set(["when", "controlFor", "clock", "states", "transition", "deviations", "platform"]);

function controlOf(type: FieldType): PanelControl {
  switch (type.k) {
    case "string":
      return { k: "text" };
    case "anchor":
      return { k: "select", options: [...ANCHORS] };
    case "number":
      return { k: "number", int: type.int === true };
    case "boolean":
      return { k: "toggle" };
    case "enum":
      return { k: "select", options: [...type.values] };
    case "literals":
      return { k: "select", options: type.values.map(String) };
    case "token":
      return { k: "token", category: type.category };
    case "val":
      return { k: "measure", category: type.category, keywords: [], percent: false, signed: false };
    case "size":
      return { k: "measure", category: "space", keywords: ["full", "auto"], percent: true, signed: false };
    case "offset":
      return { k: "measure", category: "space", keywords: [], percent: true, signed: true };
    case "ratio":
      return { k: "text" };
    case "union": {
      // `columns`: a count, or the word "auto".
      const words = type.of.flatMap((t) => (t.k === "enum" ? [...t.values] : []));
      return type.of.some((t) => t.k === "number")
        ? { k: "measure", category: "count", keywords: words, percent: false, signed: false }
        : { k: "json" };
    }
    default:
      return { k: "json" };
  }
}

function collect(fields: Fields, prefix: string, groupOf: (top: string) => PanelGroupId, out: Map<PanelGroupId, PanelField[]>): void {
  for (const [name, field] of Object.entries(fields)) {
    const top = prefix === "" ? name : (prefix.split(".")[0] as string);
    if (SKIPPED.has(top)) continue;
    const path = prefix === "" ? name : `${prefix}.${name}`;
    if (field.type.k === "object") {
      collect(field.type.fields, path, groupOf, out);
      continue;
    }
    const group = groupOf(top);
    const list = out.get(group) ?? [];
    // Of the notes a node carries, only the free-text one is for a person to write.
    if (top === "_meta" && name !== "note") continue;
    list.push(describe(path, name, field, prefix));
    out.set(group, list);
  }
}

/** Object props whose members read well alone (`Width`, `Padding`); any other says whose it is. */
const BARE_PREFIXES = new Set(["", "size", "space", "place"]);

function describe(path: string, name: string, field: Field, prefix: string): PanelField {
  const out: PanelField = {
    path,
    label: BARE_PREFIXES.has(prefix) ? humanise(name) : `${humanise(prefix.split(".")[0] as string)} ${humanise(name).toLowerCase()}`,
    control: controlOf(field.type),
    resp: field.resp === true,
  };
  if (field.doc) out.doc = field.doc;
  return out;
}

/**
 * The panel of a node type, in the order a person reaches for things. A type the vocabulary does
 * not know gets no groups.
 */
export function panelOf(type: string): PanelGroup[] {
  const spec = nodeSpec(type);
  if (!spec) return [];
  const own = OWN_GROUP[spec.kind];
  const byGroup = new Map<PanelGroupId, PanelField[]>();

  collect(spec.fields, "", () => own, byGroup);
  const universal: Fields = Object.fromEntries(
    Object.entries(allFields(spec)).filter(([name]) => !(name in spec.fields)),
  );
  collect(universal, "", (top) => UNIVERSAL_GROUP[top] ?? "behaviour", byGroup);

  return GROUPS.flatMap(({ id, title }) => {
    const fields = byGroup.get(id);
    return fields && fields.length > 0 ? [{ id, title, fields }] : [];
  });
}

/**
 * What is wrong with a node's props as the vocabulary declares them: a prop the type does not
 * have, or a value of the wrong kind. One line each, `path: why`; empty when the props are fine.
 * Token refs are checked for their shape here, not against a theme.
 */
export function propIssues(type: string, props: Record<string, unknown>): string[] {
  const spec = nodeSpec(type);
  if (!spec) return [`unknown node type "${type}"`];
  const parsed = zodOfFields(allFields(spec)).safeParse(props);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join(".") || "(props)"}: ${i.message}`);
}

/** The names of the props a node type takes, its own and the universal ones. */
export function propNamesOf(type: string): string[] {
  const spec = nodeSpec(type);
  return spec ? Object.keys(allFields(spec)) : [];
}
