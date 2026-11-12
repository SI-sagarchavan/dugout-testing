import { describe, expect, it } from "vitest";
import { loadDsl, type Tree } from "../src/dsl.ts";
import { pageAsRead } from "../src/facts.ts";

const dsl = await loadDsl();

let idx = 0;
const node = (
  id: string,
  type: string,
  parent: string | null,
  props: Record<string, unknown> = {},
) => ({ id, src: `9:${id}`, type, parent, idx: idx++, props });

/** A grid with one card drawn from the data and one left as the designer wrote it. */
const tree = {
  schemaVersion: 1,
  nodes: [
    node("root", "Stack", null),
    node("heading", "Text", "root", { content: "PHOTOS" }),
    node("grid", "Stack", "root"),
    node("bound", "Stack", "grid"),
    node("bound_img", "Image", "bound", { src: "{p.cover}" }),
    node("bound_title", "Text", "bound", { content: "{p.title}" }),
    node("left", "Stack", "grid"),
    node("left_img", "Image", "left", { src: "https://design/x.png" }),
    node("left_title", "Text", "left", { content: "Jason Roy top scored with 70 off 39" }),
    node("left_date", "Text", "left", {
      content: "Aug 28, 2025",
      when: { path: "p", exists: true },
    }),
  ],
} as unknown as Tree;

describe("the page as a person reads it (bind.try's page)", () => {
  it("lists every text and picture box by box, from the data or as designed, judging nothing", () => {
    const page = pageAsRead(
      tree,
      [{ src: "9:bound_title", prop: "content", values: ["Demo Test CMS", "Demo"] }],
      dsl.hasRef,
    );
    expect(page).toEqual([
      '(top): text heading as designed: "PHOTOS"',
      'grid / bound: picture bound_img from the data: "nothing"; text bound_title from the data: "Demo Test CMS", "Demo"',
      'grid / left: picture left_img as designed; text left_title as designed: "Jason Roy top scored with 70 off 39"; text left_date as designed: "Aug 28, 2025" (a when decides it)',
    ]);
  });
});
