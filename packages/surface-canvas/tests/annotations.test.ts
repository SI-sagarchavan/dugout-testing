import { describe, expect, it } from "vitest";
import {
  applyAnnotations,
  parseAnnotations,
  removeAnnotation,
  serializeAnnotations,
  splitAnnotations,
  upsertAnnotation,
} from "../src/annotations";
import { IR_VERSIONS, parseFrameIRDocument } from "../src/ir/index";
import { document, node } from "./health-fixtures";

const note = { id: "n1", targetId: "1:2", targetName: "stale", kind: "behaviour" as const, text: "swipes" };

function doc() {
  const child = node({ id: "1:2", name: "News strip" });
  return document(node({ id: "1:1", name: "Home", children: [child] }));
}

describe("annotations", () => {
  it("round-trips through pluginData, dropping malformed entries", () => {
    const raw = JSON.stringify([note, { id: "bad" }, { ...note, id: "n2", text: "  " }]);
    expect(parseAnnotations(raw)).toEqual([note]);
    expect(parseAnnotations(serializeAnnotations([note]))).toEqual([note]);
    expect(parseAnnotations("not json")).toEqual([]);
    expect(serializeAnnotations([])).toBe("");
  });

  it("adds, replaces by id, and removes", () => {
    const added = upsertAnnotation([], note);
    expect(upsertAnnotation(added, { ...note, text: "opens an article" })).toEqual([
      { ...note, kind: "behaviour", text: "opens an article" },
    ]);
    expect(upsertAnnotation(added, { ...note, text: "  " })).toEqual(added);
    expect(removeAnnotation(added, "n1")).toEqual([]);
  });

  it("defaults a note's kind to must-do", () => {
    const [saved] = upsertAnnotation([], { id: "n", targetId: "1:2", targetName: "x", text: "keep" });
    expect(saved?.kind).toBe("must-do");
  });

  it("keeps notes on live layers, refreshes their name, and reports the orphans", () => {
    const gone = { ...note, id: "n2", targetId: "9:9" };
    const { live, orphaned } = splitAnnotations(doc(), [note, gone]);
    expect(live).toEqual([{ ...note, targetName: "News strip" }]);
    expect(orphaned).toEqual([gone]);
    expect(applyAnnotations(doc(), [note, gone]).annotations).toHaveLength(1);
  });

  it("is on IR 1.11.0, and an older document parses with no notes", () => {
    expect(IR_VERSIONS).toContain("1.11.0");
    const { annotations: _omit, ...older } = doc();
    const parsed = parseFrameIRDocument({ ...older, irVersion: "1.10.0" });
    expect(parsed.annotations).toEqual([]);
  });

  it("survives a document round-trip through the schema", () => {
    const withNotes = applyAnnotations(doc(), [note]);
    expect(parseFrameIRDocument(JSON.parse(JSON.stringify(withNotes))).annotations).toHaveLength(1);
  });
});
