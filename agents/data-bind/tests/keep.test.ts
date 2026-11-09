import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { loadDsl } from "../src/dsl.ts";
import { unboundCopy } from "../src/facts.ts";
import { applyKeep, createBindTools, type Problem } from "../src/tools.ts";

const dsl = await loadDsl();

type Node = { id: string; src: string; type: string; parent: string | null; props: object };
const node = (
  id: string,
  type: string,
  parent: string | null,
  props: Record<string, unknown> = {},
): Node => ({ id, src: `35:${id}`, type, parent, props });

/**
 * A section as the Handoff in the run that started this: a heading and its VIEW MORE button over
 * a row of video cards, a date and a duration on each card.
 */
const design = {
  schemaVersion: 1,
  nodes: [
    node("1", "Overlay", null),
    node("2", "Stack", "1"),
    node("3", "Stack", "2"),
    node("4", "Text", "3", { content: "BRAVE CORNER" }),
    node("5", "Button", "3", { label: "VIEW MORE" }),
    node("6", "Stack", "2"),
    node("7", "Stack", "6"),
    node("8", "Text", "7", { content: "14 jun 2024" }),
    node("9", "Text", "7", { content: "09:11" }),
  ],
};

/** The same section once the cards are a list: one card repeats, its date bound. */
const applied = {
  schemaVersion: 1,
  nodes: [
    ...design.nodes.slice(0, 6),
    node("r", "Repeater", "6", { over: "news.articles", as: "a" }),
    node("7", "Stack", "r"),
    node("8", "Text", "7", { content: "{a.date}" }),
    node("9", "Text", "7", { content: "09:11" }),
  ],
};

const plan = {
  collapse: [
    {
      over: "news.articles",
      as: "a",
      members: ["35:7"],
      fields: [{ src: "35:8", prop: "content", path: "date" }],
    },
  ],
};

describe("design copy beside data", () => {
  it("leaves out the section's heading beside its list, and still reports copy in a card", () => {
    // the card's own copy sits in the repeat: dryRun reports it, not this
    expect(unboundCopy(applied as never, dsl.hasRef)).toEqual([]);
    // the same heading in a block that holds bound data is a placeholder
    const beside = {
      schemaVersion: 1,
      nodes: [
        node("1", "Overlay", null),
        node("2", "Stack", "1"),
        node("3", "Stack", "2"),
        node("4", "Text", "3", { content: "32" }),
        node("8", "Text", "3", { content: "{hero.title}" }),
      ],
    };
    expect(unboundCopy(beside as never, dsl.hasRef)).toEqual([
      { src: "35:4", copy: "32", within: "35:3" },
    ]);
  });
});

describe("a plan's keep", () => {
  const label: Problem = { message: "35:4 still shows BRAVE CORNER", src: "35:4", keep: true };
  const look: Problem = { message: "the members differ in look", src: "35:7", keep: true };
  const duration: Problem = { message: "35:9 shows 09:11 on every item", src: "35:9", keep: true };
  const broken: Problem = { message: "35:8 src loads nothing", src: "35:8" };

  it("accepts every problem under a static block that holds nothing bound", () => {
    const kept = applyKeep([label, duration], design as never, {
      ...plan,
      keep: [{ src: "35:3", why: "the section's heading and its button" }],
    });
    expect(kept.open).toEqual([duration]);
    expect(kept.kept).toEqual([
      "35:3 kept as designed: the section's heading and its button (accepts: 35:4 still shows BRAVE CORNER)",
    ]);
    expect(kept.notes).toEqual([]);
  });

  it("lets a block that holds bound nodes accept only problems on itself", () => {
    const kept = applyKeep([look, duration], design as never, {
      ...plan,
      keep: [{ src: "35:7", why: "the third card's restyle is the designer's" }],
    });
    // the look is the card's own; the placeholder in it is not, so it stays open
    expect(kept.open).toEqual([duration]);
    const root = applyKeep([label, duration], design as never, {
      ...plan,
      keep: [{ src: "35:1", why: "everything stays as designed" }],
    });
    expect(root.open).toEqual([label, duration]);
    expect(root.notes[0]).toContain("holds nodes the plan binds");
  });

  it("never accepts what shows broken, and names a keep that is not in the frame", () => {
    const kept = applyKeep([broken], design as never, {
      ...plan,
      keep: [
        { src: "35:8", why: "the picture stays as designed" },
        { src: "99:1", why: "not a node of this frame" },
      ],
    });
    expect(kept.open).toEqual([broken]);
    expect(kept.notes).toEqual([
      "keep names 99:1, which is not a node of the frame: use an id from the outline",
    ]);
  });
});

describe("bind.publish", () => {
  const ctx = (runId: string): ToolContext => ({
    tenantId: "bind-keep",
    runId,
    signal: new AbortController().signal,
    input: {
      preview: "http://localhost:3000/preview/default/6f0e8c1a-0000-4000-8000-000000000001",
    },
  });
  const tried = (problems: string[]) => ({
    tried: { plan: {}, problems, kept: [], bound: 1, collapsed: 1 },
  });
  /** What the pipeline does: resolve the call, then ask block about what it resolved to. */
  const gate = async (state: object, input: object) => {
    const dir = await mkdtemp(join(tmpdir(), "bind-keep-"));
    await writeFile(join(dir, "run.json"), JSON.stringify(state));
    const publish = createBindTools({ dir }).find((t) => t.name === "bind.publish") as Tool<
      unknown,
      unknown,
      unknown
    >;
    const resolved = publish.resolve?.(input, ctx("run")) ?? input;
    return { resolved, refused: publish.block?.(resolved, ctx("run")) };
  };

  it("lets a plan with no open problems through at once", async () => {
    expect((await gate(tried([]), {})).refused).toBeUndefined();
  });

  it("refuses open problems, and says how to fix, keep, or publish despite them", async () => {
    const { refused } = await gate(tried(["35:9 shows 09:11"]), {});
    expect(refused).toContain("Not yet");
    expect(refused).toContain("keep");
    expect(refused).toContain("despite");
  });

  it("publishes despite open problems when it says why, and shows why at the approval", async () => {
    const { resolved, refused } = await gate(tried(["35:9 shows 09:11"]), {
      despite: "the data has no duration for a video",
    });
    expect(refused).toBeUndefined();
    expect(resolved).toMatchObject({ despite: "the data has no duration for a video" });
  });
});
