import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, memoryRunState, type Tool, type ToolContext } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { completeFinal, threadNote, verifyFinal } from "../src/agent.ts";
import { createdIn } from "../src/ending.ts";
import { createBindTools, type Plane, PUBLISHED } from "../src/tools.ts";

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
  state: memoryRunState(),
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

/** What bind.done answered, as it keeps it in the run's state (ADR 0035). */
const published = (extra: object = {}): Record<string, unknown> => ({
  previewUrl: PREVIEW,
  planArtifactId: "plan-1",
  dataArtifactId: "data-1",
  bound: 4,
  collapsed: 1,
  problems: [],
  kept: [],
  sources: [],
  ...extra,
});

/** A run as the checks on final read it: its transcript, and what bind.done kept in its state. */
const runOf = (messages: Message[], kept?: Record<string, unknown>) => {
  const state = memoryRunState();
  if (kept) state.set(PUBLISHED, kept);
  return { messages, state };
};

const final = {
  previewUrl: "",
  planArtifactId: "",
  dataArtifactId: "",
  bound: 0,
  collapsed: 0,
  data: "bound" as const,
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

    // the tool kept its answer in the run's state, where the checks on final read it
    expect(run.state.get(PUBLISHED)).toMatchObject({ none: why });
    const ended = runOf(
      hookMaker({ hookId: null, missing: ["everything"] }),
      published({ none: why, planArtifactId: "", dataArtifactId: "", bound: 0, collapsed: 0 }),
    );
    const result = completeFinal(final, ended) as Record<string, unknown>;
    expect(result).toMatchObject({ static: true, data: "none", dataWhy: why, bound: 0 });
    expect(verifyFinal(result, ended)).toBeUndefined();
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
    expect(verifyFinal({ remaining: [], notes: [] }, runOf([]))).toMatch(/with none/);
  });

  it("takes the model's reading of the evidence: bound, or a stand-in with why", () => {
    const run = runOf(hookMaker({ hookId: "dugout_squad", missing: [] }), published());
    const ok = completeFinal({ ...final, dataWhy: "" }, run) as Record<string, unknown>;
    expect(ok).toMatchObject({ data: "bound", bound: 4 });
    expect(ok.dataWhy).toBeUndefined();
    expect(verifyFinal(ok, run)).toBeUndefined();

    // code does not read the team from the data: what the model says stands
    const standIn = completeFinal(
      {
        ...final,
        data: "stand-in",
        dataWhy: "the data names Riverside FC, the design Western Stars",
      },
      run,
    ) as Record<string, unknown>;
    expect(standIn).toMatchObject({
      data: "stand-in",
      dataWhy: expect.stringContaining("Riverside"),
    });
    expect(verifyFinal(standIn, run)).toBeUndefined();
    expect(threadNote({}, standIn)).toContain("stand-in data");
  });

  it("asks for why with a stand-in, and refuses none when a plan was published", () => {
    const run = runOf([], published());
    expect(verifyFinal(completeFinal({ ...final, data: "stand-in" }, run), run)).toMatch(
      /say in dataWhy/,
    );
    expect(verifyFinal(completeFinal({ ...final, data: "none" }, run), run)).toMatch(
      /binds 4 prop\(s\): data is bound or stand-in/,
    );
  });

  it("is none whatever the model says when nothing was bound", () => {
    const why = "no feed was given";
    const run = runOf(
      [],
      published({ none: why, planArtifactId: "", dataArtifactId: "", bound: 0, collapsed: 0 }),
    );
    expect(completeFinal({ ...final, data: "bound" }, run)).toMatchObject({
      data: "none",
      dataWhy: why,
    });
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
    const done = completeFinal(final, runOf(first, published())) as {
      created?: string[];
    };
    expect(done.created).toHaveLength(2);
  });
});
