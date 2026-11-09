/**
 * Designer notes: what the frame cannot show, written on the layer it is about.
 *
 * A note is intent ("this strip swipes", "the badge is a live score"), not a
 * re-description of the layout, which Figma already holds. Notes live in
 * pluginData on the export root, travel in the IR's `annotations` list, and so
 * need no new file in the Send.
 *
 * PURE. No Figma: the sandbox reads and writes pluginData; this file decides
 * what a valid list is and how it lands on the IR.
 */
import {
  ANNOTATION_MAX_CHARS,
  annotationSchema,
  type Annotation,
  type AnnotationKind,
  type FrameIRDocument,
  type FrameIRNode,
} from "./ir/schema.js";

export { ANNOTATION_MAX_CHARS, ANNOTATION_PLUGIN_KEY } from "./ir/schema.js";
export type { Annotation, AnnotationKind } from "./ir/schema.js";

export const ANNOTATION_KINDS: readonly AnnotationKind[] = [
  "must-do",
  "data",
  "behaviour",
  "ignore",
  "section",
  "background",
];

export function parseAnnotations(raw: string): Annotation[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const result = annotationSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

export function serializeAnnotations(notes: readonly Annotation[]): string {
  return notes.length === 0 ? "" : JSON.stringify(notes);
}

/** Add a note, or replace the one with the same id. Returns the list unchanged if the text is empty. */
export function upsertAnnotation(
  notes: readonly Annotation[],
  note: Omit<Annotation, "kind"> & { kind?: AnnotationKind },
): Annotation[] {
  const parsed = annotationSchema.safeParse(note);
  if (!parsed.success) return [...notes];
  const exists = notes.some((n) => n.id === parsed.data.id);
  return exists
    ? notes.map((n) => (n.id === parsed.data.id ? parsed.data : n))
    : [...notes, parsed.data];
}

export function removeAnnotation(notes: readonly Annotation[], id: string): Annotation[] {
  return notes.filter((n) => n.id !== id);
}

export interface AnnotationSplit {
  /** Notes whose layer is in the frame; these travel. */
  live: Annotation[];
  /** Notes whose layer was deleted or is hidden; these are dropped and the designer is told. */
  orphaned: Annotation[];
}

/** Sort notes by whether their layer is still in this tree, refreshing each note's recorded name. */
export function splitAnnotations(
  doc: FrameIRDocument,
  notes: readonly Annotation[],
): AnnotationSplit {
  const names = new Map<string, string>();
  const visit = (node: FrameIRNode): void => {
    names.set(node.id, node.name);
    for (const child of node.children) visit(child);
  };
  visit(doc.root);
  const live: Annotation[] = [];
  const orphaned: Annotation[] = [];
  for (const note of notes) {
    const name = names.get(note.targetId);
    if (name === undefined) orphaned.push(note);
    else live.push({ ...note, targetName: name });
  }
  return { live, orphaned };
}

/** Stamp `doc.annotations` with the notes whose layer is in the tree. */
export function applyAnnotations(
  doc: FrameIRDocument,
  notes: readonly Annotation[],
): FrameIRDocument {
  return { ...doc, annotations: splitAnnotations(doc, notes).live };
}
