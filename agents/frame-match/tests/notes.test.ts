import type { Message } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { listedNoteIds, notesOf, unreportedNotes } from "../src/notes.ts";

const names = new Map([
  ["1:1", "Home"],
  ["1:2", "News strip"],
]);
const parents = new Map<string, string | null>([
  ["1:1", null],
  ["1:2", "1:1"],
]);
const note = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  targetId: "1:2",
  targetName: "News strip",
  kind: "behaviour",
  text: "swipes",
  ...over,
});

describe("designer notes", () => {
  it("lists each note with the path to its layer, and drops those on missing layers", () => {
    const found = notesOf(
      { annotations: [note(), note({ id: "n2", targetId: "9:9" }), { id: 3 }] },
      names,
      parents,
    );
    expect(found).toEqual([
      { id: "n1", kind: "behaviour", text: "swipes", src: "1:2", path: "Home / News strip" },
    ]);
  });

  it("treats a document with no notes, or an unknown kind, safely", () => {
    expect(notesOf({}, names, parents)).toEqual([]);
    expect(notesOf({ annotations: [note({ kind: "weird" })] }, names, parents)[0]?.kind).toBe(
      "must-do",
    );
  });

  it("reads the ids a tool listed, and asks for the ones the answer misses", () => {
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "frame.load", input: {} }] },
      {
        role: "tool",
        toolCallId: "c1",
        content: JSON.stringify({ designerNotes: [{ id: "n1" }, { id: "n2" }] }),
      },
    ] as Message[];
    const listed = listedNoteIds(messages, "frame.load");
    expect(listed).toEqual(["n1", "n2"]);
    expect(
      unreportedNotes(listed, [{ id: "n1", status: "addressed", detail: "carousel" }]),
    ).toMatch(/n2/);
    expect(
      unreportedNotes(listed, [
        { id: "n1", status: "addressed", detail: "x" },
        { id: "n2", status: "not-mine", detail: "y" },
      ]),
    ).toBeUndefined();
    expect(unreportedNotes([], undefined)).toBeUndefined();
  });
});
