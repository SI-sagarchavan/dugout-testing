import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Tool, ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { completeFinal, threadNote, verifyFinal } from "../src/agent.ts";
import { createdIn, dataSourceAnswer, standInIn } from "../src/ending.ts";
import { createBindTools, type Plane } from "../src/tools.ts";

const TREE_ID = "6f0e8c1a-0000-4000-8000-000000000009";
const PREVIEW = `http://localhost:3000/preview/default/${TREE_ID}`;
const nothing = async () => {
  throw new Error("not used");
};
const plane: Plane = {
  json: async () => ({
    schemaVersion: "1",
    nodes: [
      { id: "root", idx: 0, parent: null, src: "root", type: "Stack", props: {} },
      {
        id: "t",
        idx: 0,
        parent: "root",
        src: "t",
        type: "Text",
        props: { content: "Player Name" },
      },
    ],
  }),
  meta: async () => ({}),
  exportIr: nothing,
  ir: nothing,
  dataset: nothing,
  upload: async (kind) => {
    throw new Error(`nothing is stored, but ${kind} was uploaded`);
  },
};
const ctx = (runId: string, slot?: unknown): ToolContext => ({
  tenantId: "sb",
  runId,
  signal: new AbortController().signal,
  input: { preview: PREVIEW, ...(slot ? { slot } : {}) },
});
const SLOT = { id: "sq", name: "the-brave-squad", nodes: ["t"], readFrom: [] };

/** A transcript in which hook-maker answered, and what the model had asked it. */
const hookMaker = (output: object, must = { team: "Southern Brave" }): Message[] =>
  [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "h",
          name: "agent.hookMaker",
          arguments: JSON.stringify({
            need: { list: "players", count: "data", item: [], must },
          }),
        },
      ],
    },
    { role: "tool", toolCallId: "h", content: JSON.stringify({ runId: "r", output }) },
  ] as never;

/** bind.source's result: the source's name, its hook, and what code read of its data. */
const sourced = (hookId: string, reading: string, why?: string, as = "squad"): Message[] =>
  [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: `s-${hookId}`, name: "bind.source", arguments: JSON.stringify({ hookId }) },
      ],
    },
    {
      role: "tool",
      toolCallId: `s-${hookId}`,
      content: JSON.stringify({
        as,
        hookId,
        data: "",
        about: { reading, ...(why ? { why } : {}) },
      }),
    },
  ] as never;

/** bind.load's result, with what a person decided on the section before (memory). */
const loadedWith = (settled?: string): Message[] =>
  [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "l", name: "bind.load", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "l",
      content: JSON.stringify({
        frame: "",
        ...(settled ? { settled: { data_source: settled } } : {}),
      }),
    },
  ] as never;

const asked = (answer: string): Message[] =>
  [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "a", name: "ask", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "a",
      content: JSON.stringify({ answeredBy: "p", answers: [{ id: "data_source", answer }] }),
    },
  ] as never;

const published = (extra: object = {}): Message[] =>
  [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "p", name: "bind.done", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "p",
      content: JSON.stringify({
        previewUrl: PREVIEW,
        planArtifactId: "plan-1",
        dataArtifactId: "data-1",
        bound: 4,
        collapsed: 1,
        problems: [],
        kept: [],
        sources: [],
        ...extra,
      }),
    },
  ] as never;

const final = {
  previewUrl: "",
  planArtifactId: "",
  dataArtifactId: "",
  bound: 0,
  collapsed: 0,
  remaining: [],
  notes: [],
};

describe("a slot ends bound, stand-in or none, never by failing (ticket 05)", () => {
  it("ends a slot with no data through bind.done and none: no plan, nothing stored, the run completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bind-none-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const done = tools.find((t) => t.name === "bind.done") as Tool;
    const run = ctx("none-slot", SLOT);
    const why = "hook-maker found no hook about Southern Brave, and no feed was given";
    // before: "Nothing to publish. Call bind.try with a plan first."
    expect(await done.block?.({ none: why }, run)).toBeUndefined();
    const out = (await done.run({ none: why }, run)) as Record<string, unknown>;
    expect(out).toMatchObject({ none: why, planArtifactId: "", dataArtifactId: "", bound: 0 });

    const messages = [
      ...hookMaker({ hookId: null, missing: ["everything"] }),
      ...published({ none: why, planArtifactId: "", dataArtifactId: "", bound: 0, collapsed: 0 }),
    ];
    const result = completeFinal(final, { messages }) as Record<string, unknown>;
    expect(result).toMatchObject({ static: true, data: "none", dataWhy: why, bound: 0 });
    expect(verifyFinal(result, { messages })).toBeUndefined();
    expect(threadNote({}, result)).toContain(why);
  });

  it("does the same for a whole frame through bind.publish, and keeps each tool to its own run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bind-none-"));
    const tools = createBindTools({ dir, plane: () => plane });
    const publish = tools.find((t) => t.name === "bind.publish") as Tool;
    const done = tools.find((t) => t.name === "bind.done") as Tool;
    const why = "no data could be had for this frame";
    expect(await publish.block?.({ none: why }, ctx("none-frame"))).toBeUndefined();
    expect(await done.block?.({ none: why }, ctx("none-frame"))).toMatch(/call bind.publish/);
    expect(await publish.block?.({ none: why }, ctx("none-slot-2", SLOT))).toMatch(
      /call bind.done/,
    );
  });

  it("still says what to do when nothing was published, and names none", () => {
    expect(verifyFinal({ remaining: [], notes: [] }, { messages: [] })).toMatch(/with none/);
  });

  it("reports a plan as bound, unless the source's data is about something else", () => {
    // what hook-maker writes in missing is no evidence either way: a line naming the team is not
    const bound = [
      ...hookMaker({ hookId: "dugout_squad", missing: ["Southern Brave crest URL"] }),
      ...sourced("dugout_squad", "unknown"),
    ];
    const ok = completeFinal(final, { messages: [...bound, ...published()] }) as Record<
      string,
      unknown
    >;
    expect(ok).toMatchObject({ data: "bound" });
    expect(ok.dataWhy).toBeUndefined();

    // set by code: the data's team fields name only other teams
    const other = [
      ...hookMaker({ hookId: "dugout_other_squad", missing: [] }),
      ...sourced("dugout_other_squad", "other", "the data is about Riverside FC"),
    ];
    const standIn = completeFinal(final, { messages: [...other, ...published()] }) as Record<
      string,
      unknown
    >;
    expect(standIn).toMatchObject({
      data: "stand-in",
      dataWhy: expect.stringContaining("Riverside FC"),
      bound: 4,
    });
    expect(threadNote({}, standIn)).toContain("stand-in data");
  });

  it("reads the readings bind.publish recorded: a wrong team the plan kept with why is bound", () => {
    const messages = [
      ...hookMaker({ hookId: "dugout_table", missing: [] }),
      ...sourced("dugout_table", "other", "the data is about Riverside FC"),
      ...published({
        readings: [{ as: "squad", hookId: "dugout_table", reading: "other", why: "x", kept: true }],
      }),
    ];
    expect(completeFinal(final, { messages })).toMatchObject({ data: "bound" });
  });

  it("takes a stand-in from the data itself when bind.publish read it so, whatever hook-maker wrote", () => {
    // hook-maker's missing says nothing of the team; the published data does not name it
    const quiet = hookMaker({ hookId: "dugout_other_squad", missing: [] });
    const result = completeFinal(final, {
      messages: [
        ...quiet,
        ...published({
          standIn: "the data is about Punjab Kings, the design is about Southern Brave",
        }),
      ],
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      data: "stand-in",
      dataWhy: expect.stringContaining("Punjab Kings"),
    });
  });

  it("is a stand-in when a person chose the closest hook, and not once the right data came", () => {
    const closest = [
      ...hookMaker({ hookId: "dugout_ipl_squad", missing: [] }),
      ...asked("stand_in"),
      ...sourced("dugout_ipl_squad", "unknown"),
    ];
    expect(standInIn(closest)).toMatch(/person chose the closest hook, dugout_ipl_squad/);
    // feeds given instead: no stand-in
    expect(
      standInIn([
        ...hookMaker({ hookId: "dugout_ipl_squad", missing: [] }),
        ...asked("women: https://x.test/s?team_id=1"),
        ...sourced("dugout_ipl_squad", "unknown"),
      ]),
    ).toBeUndefined();
    // stand_in, then the right hook (another, after the answer): the latest source decides
    const mended = [
      ...closest,
      ...hookMaker({ hookId: "dugout_brave", missing: [], basis: "found" }),
      ...sourced("dugout_brave", "unknown"),
    ];
    expect(standInIn(mended)).toBeUndefined();
    // a hook the person's own feeds built is theirs, whatever they answered before
    const theirs = [
      ...asked("stand_in"),
      ...hookMaker({ hookId: "dugout_ipl_squad", missing: [], basis: "sources" }),
      ...sourced("dugout_ipl_squad", "unknown"),
    ];
    expect(standInIn(theirs)).toBeUndefined();
    // data that names the design's team is not a stand-in
    expect(
      standInIn([...closest.slice(0, 4), ...sourced("dugout_ipl_squad", "about")]),
    ).toBeUndefined();
  });

  it("is a stand-in when memory settled it before this run: whoever settled it", () => {
    const fromMemory = [
      ...loadedWith("stand_in"),
      ...hookMaker({ hookId: "dugout_events", missing: [], basis: "found" }),
      ...sourced("dugout_events", "unknown", undefined, "events"),
    ];
    expect(dataSourceAnswer(fromMemory)).toBe("stand_in");
    const result = completeFinal(final, { messages: [...fromMemory, ...published()] });
    expect(result).toMatchObject({ data: "stand-in" });
    // a person answering again in this run wins over memory
    expect(dataSourceAnswer([...fromMemory, ...asked("find_hook")])).toBe("find_hook");
    expect(standInIn([...fromMemory, ...asked("find_hook")])).toBeUndefined();
  });

  it("lists what hook-maker created, once, from its answers", () => {
    const first = hookMaker({
      hookId: "dugout_a",
      missing: [],
      created: ["provider p1 (dugout: h)", "connector c1 (dugout: a)"],
    });
    const second = hookMaker({
      hookId: "dugout_a",
      missing: [],
      created: ["connector c1 (dugout: a)"],
    });
    expect(createdIn([...first, ...second])).toEqual([
      "provider p1 (dugout: h)",
      "connector c1 (dugout: a)",
    ]);
    expect(createdIn(hookMaker({ hookId: null, missing: [] }))).toEqual([]);
    const done = completeFinal(final, { messages: [...first, ...published()] }) as {
      created?: string[];
    };
    expect(done.created).toHaveLength(2);
  });
});
