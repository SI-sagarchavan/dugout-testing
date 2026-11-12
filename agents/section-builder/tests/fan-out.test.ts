import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlane } from "@dugout/agent-frame-match";
import { AwaitingAnswers, type OpenItem } from "@dugout/contracts";
import {
  createMemoryOutputStore,
  createMemoryRunStore,
  createMemorySink,
  createScriptedModel,
  runLocal,
  scriptedModelConfig,
} from "@dugout/core";
import { describe, expect, it } from "vitest";
import { type BudgetDecision, makeStages, Output, settleBudget, threadNote } from "../src/agent.ts";
import { mergeBindings } from "../src/merge.ts";

const EXPORT = "6f0e8c1a-0000-4000-8000-000000000001";
const slot = (id: string, name: string, data: "some" | "none" = "some") => ({
  id,
  name,
  nodes: [id],
  content: { data, evidence: [] as string[] },
  writes: [] as string[],
  reads: [] as string[],
  signature: `sig-${id}`,
  confidence: "sure" as const,
});
const frame = {
  previewUrl: "http://localhost:3000/preview/default/tree-1?theme=t",
  treeArtifactId: "tree-1",
  measured: true,
  coverage: 93,
  estimated: false,
  unchecked: [],
  placeholderIcons: 0,
  before: 80,
  match: 95,
  remaining: [],
  compilerFindings: [],
  notes: [],
  content: { data: "some" as const, evidence: ["fixtures repeat"] },
  slots: [slot("fx", "the-road-ahead"), slot("sq", "the-brave-squad")],
};
const plans: Record<string, unknown> = {
  "plan-fx": {
    note: "fixtures",
    collapse: [{ over: "fixtures.items", as: "m", members: ["fc1", "fc2"] }],
  },
  "plan-sq": {
    note: "squad",
    collapse: [{ over: "squad.items", as: "p", members: ["sc1", "sc2"] }],
    bind: [{ src: "sq-h", prop: "content", path: "squad.items.0.name" }],
  },
  "data-fx": { fixtures: { items: [{ title: "a" }] } },
  "data-sq": { squad: { items: [{ name: "b" }] } },
};
const bound = (key: string, hookId: string, bind = 5) => ({
  previewUrl: frame.previewUrl,
  planArtifactId: `plan-${key}`,
  dataArtifactId: `data-${key}`,
  bound: bind,
  collapsed: 1,
  remaining: [`the ${key} has no photo`],
  notes: [],
  sources: [{ kind: "cast-hook", hookId, as: key === "fx" ? "fixtures" : "squad", input: {} }],
});

const fake = () => {
  const uploads: Array<{ kind: string; json: unknown; meta: Record<string, unknown> }> = [];
  const plane = {
    json: async (id: string) => plans[id] ?? { nodes: [] },
    upload: async (kind: string, json: unknown, meta: Record<string, unknown>) => {
      uploads.push({ kind, json, meta });
      return `${kind}-merged`;
    },
  } as unknown as ControlPlane;
  const dsl = {
    applyBindingPlan: (tree: unknown) => ({ tree, bound: 0, collapsed: 0, drift: [] }),
    check: () => [],
  };
  const build = makeStages({
    plane: () => plane,
    dsl: async () => dsl as never,
  });
  return { build, uploads };
};

describe("section-builder on a frame of two slots", () => {
  it("binds each slot with its own run, merges the plans and publishes once", async () => {
    const { build, uploads } = fake();
    const calls: Array<{ agent: string; input: unknown; key?: string | undefined }> = [];
    const answer = await build(
      async (child, input, opts) => {
        calls.push({ agent: child.spec.id, input, key: opts?.key });
        if (child.spec.id === "frame-match") return frame;
        const key = (input as { slot: { id: string } }).slot.id;
        return bound(key, key === "fx" ? "dugout_fixtures" : "dugout_squad");
      },
      { exportId: EXPORT, project: "default" },
    );
    expect(calls.map((c) => [c.agent, c.key])).toEqual([
      ["frame-match", undefined],
      ["data-bind", "fx"],
      ["data-bind", "sq"],
    ]);
    expect(calls[2]?.input).toMatchObject({
      preview: frame.previewUrl,
      slot: { id: "sq", name: "the-brave-squad", nodes: ["sq"], signature: "sig-sq" },
    });
    // one publish: one plan with both slots' lists, one data map with both sources
    expect(uploads.map((u) => u.kind)).toEqual(["sample_data", "binding_plan"]);
    expect(uploads[0]?.json).toEqual({
      ...(plans["data-fx"] as object),
      ...(plans["data-sq"] as object),
    });
    expect(uploads[1]?.json).toMatchObject({ collapse: [expect.anything(), expect.anything()] });
    expect(uploads[1]?.meta.data).toEqual([
      expect.objectContaining({ hookId: "dugout_fixtures", as: "fixtures" }),
      expect.objectContaining({ hookId: "dugout_squad", as: "squad" }),
    ]);
    expect(answer).toMatchObject({
      data: "bound",
      bound: 10,
      collapsed: 2,
      planArtifactId: "binding_plan-merged",
      dataArtifactId: "sample_data-merged",
      slots: [
        { name: "the-road-ahead", data: "bound", hookId: "dugout_fixtures", bound: 5 },
        { name: "the-brave-squad", data: "bound", hookId: "dugout_squad", bound: 5 },
      ],
    });
    expect((answer as { previewUrl: string }).previewUrl).toContain("plan=binding_plan-merged");
    expect((answer as { remaining: string[] }).remaining).toContain(
      "data: the-road-ahead: the fx has no photo",
    );
  });

  it("reports a slot bound to another team's data as a stand-in, in the output, the remaining and the thread note", async () => {
    const { build } = fake();
    const why =
      "the data is not about the design's team (Southern Brave): the hook gives an IPL squad";
    const answer = (await build(
      async (child, input) => {
        if (child.spec.id === "frame-match") return frame;
        const id = (input as { slot: { id: string } }).slot.id;
        return id === "sq"
          ? { ...bound(id, "dugout_ipl_squad"), data: "stand-in", dataWhy: why }
          : { ...bound(id, "dugout_fixtures"), data: "bound" };
      },
      { exportId: EXPORT, project: "default" },
    )) as Output;
    expect(answer).toMatchObject({
      data: "stand-in",
      dataWhy: [expect.stringContaining("the-brave-squad: the data is not about")],
      slots: [
        { name: "the-road-ahead", data: "bound" },
        { name: "the-brave-squad", data: "stand-in", dataWhy: why },
      ],
    });
    expect(answer.remaining).toContain(
      `data: the-brave-squad: bound to stand-in data (${why}): it shows another team's data for the shape, not the design's`,
    );
    const note = threadNote({}, answer);
    expect(note).toContain("the-brave-squad bound to stand-in data");
    expect(note).toContain("the-road-ahead bound (5 props");
    // the bound slot's props are the design's data; only the stand-in's are not (ticket 12)
    expect(note).toContain("5 props bound to the design's data");
    expect(note).toContain("5 props bound to data that is not the design's");
    expect(note).not.toContain("10 props bound to data that is not the design's");
    expect(Output.shape.data.safeParse("stand-in").success).toBe(true);
  });

  it("hands a frame of one slot over as a stand-in when bind says so", async () => {
    const { build } = fake();
    const answer = (await build(
      async (child) =>
        child.spec.id === "frame-match"
          ? { ...frame, slots: [slot("sq", "the-brave-squad")] }
          : { ...bound("sq", "dugout_ipl_squad"), data: "stand-in", dataWhy: "an IPL squad" },
      { exportId: EXPORT, project: "default" },
    )) as Output;
    expect(answer).toMatchObject({
      data: "stand-in",
      slots: [{ name: "the-brave-squad", data: "stand-in", dataWhy: "an IPL squad" }],
    });
    expect(answer.remaining.join("\n")).toContain("bound to stand-in data (an IPL squad)");
    expect(threadNote({}, answer)).toContain("with stand-in data");
  });

  it("lists what the pass created in Cast, in the output and the thread note (ticket 12)", async () => {
    const { build } = fake();
    const made = ["provider prov_1 (dugout: www.example.com)", "connector api_1 (dugout: Squad)"];
    const answer = (await build(
      async (child, input) => {
        if (child.spec.id === "frame-match") return frame;
        const id = (input as { slot: { id: string } }).slot.id;
        // the squad's run made a connector; the fixtures' run reused it
        return { ...bound(id, "dugout_x"), created: id === "sq" ? made : [made[0]] };
      },
      { exportId: EXPORT, project: "default" },
    )) as Output;
    expect(answer.created).toEqual(made);
    expect(threadNote({}, answer)).toContain(
      "Created in Cast, where every hook can use it: provider prov_1",
    );
  });

  it("leaves a slot with no data as published, and binds the other", async () => {
    const { build } = fake();
    const ran: string[] = [];
    const answer = await build(
      async (child, input) => {
        ran.push(child.spec.id);
        if (child.spec.id === "frame-match") {
          return {
            ...frame,
            slots: [slot("fx", "the-road-ahead", "none"), slot("sq", "the-brave-squad")],
          };
        }
        return bound((input as { slot: { id: string } }).slot.id, "dugout_squad");
      },
      { exportId: EXPORT, project: "default" },
    );
    expect(ran).toEqual(["frame-match", "data-bind"]);
    expect(answer).toMatchObject({
      slots: [
        { name: "the-road-ahead", data: "none" },
        { name: "the-brave-squad", data: "bound" },
      ],
    });
  });

  it("publishes the slots that bound when another failed for good, and says which", async () => {
    const { build } = fake();
    const answer = await build(
      async (child, input) => {
        if (child.spec.id === "frame-match") return frame;
        const id = (input as { slot: { id: string } }).slot.id;
        if (id === "fx") {
          throw new Error(
            "data-bind for fx (run r) failed. Try 3 of 3; it is not tried again: a person has to look.",
          );
        }
        return bound(id, "dugout_squad");
      },
      { exportId: EXPORT, project: "default" },
    );
    expect(answer).toMatchObject({
      slots: [
        { name: "the-road-ahead", data: "failed" },
        { name: "the-brave-squad", data: "bound" },
      ],
    });
    expect((answer as { remaining: string[] }).remaining.join("\n")).toMatch(
      /the-road-ahead: not bound: data-bind for fx/,
    );
  });

  it("asks for each stage to be tried again when it fails, three times at most", async () => {
    const { build } = fake();
    const tries: Array<[string, number | undefined]> = [];
    await build(
      async (child, input, opts) => {
        tries.push([child.spec.id, opts?.tries]);
        if (child.spec.id === "frame-match") return frame;
        return bound((input as { slot: { id: string } }).slot.id, "dugout_squad");
      },
      { exportId: EXPORT, project: "default" },
    );
    // the trying again is the workflow's (`ctx.run`): a slot that still fails after it is final
    expect(tries).toEqual([
      ["frame-match", 3],
      ["data-bind", 3],
      ["data-bind", 3],
    ]);
  });

  it("passes a pause for a person up, not swallowing it as a failed slot", async () => {
    const { build } = fake();
    const asking = new AwaitingAnswers([], ["child"]);
    await expect(
      build(
        async (child, input) => {
          if (child.spec.id === "frame-match") return frame;
          if ((input as { slot: { id: string } }).slot.id === "fx") throw asking;
          return bound("sq", "dugout_squad");
        },
        { exportId: EXPORT, project: "default" },
      ),
    ).rejects.toBe(asking);
  });

  describe("when the slots could spend more of Cast than an hour holds", () => {
    const many = Array.from({ length: 5 }, (_, i) => slot(`s${i}`, `slot-${i}`));
    /** Runs the pass with a settle step that answers `decided`, and says what the step was given. */
    const runWith = async (decided: BudgetDecision = { bind: [], decidedBy: "agent" }) => {
      const { build } = fake();
      const keys: string[] = [];
      const asked: Array<{ open: OpenItem; parts: string[] }> = [];
      const answer = await build(
        async (child, input, opts) => {
          if (child.spec.id === "frame-match") return { ...frame, slots: many };
          if (child.spec.id === settleBudget.spec.id) {
            asked.push(input as { open: OpenItem; parts: string[] });
            return decided;
          }
          keys.push(opts?.key ?? "");
          return bound("fx", "h");
        },
        { exportId: EXPORT, project: "default" },
      );
      return {
        answer: answer as unknown as {
          slots: Array<{ name: string; data: string }>;
          remaining: string[];
          settled: Array<{ id: string; by: string; value: string }>;
        },
        keys,
        asked,
      };
    };

    it("hands the budget to a step as an open item, with its evidence, before anything is bound", async () => {
      const { keys, asked } = await runWith();
      expect(keys).toEqual([]);
      // no question is built by code: the step's model asks, in its own words
      expect(asked).toHaveLength(1);
      const open = asked[0]?.open;
      expect(asked[0]?.parts).toEqual(["slot-0", "slot-1", "slot-2", "slot-3", "slot-4"]);
      expect(open).toMatchObject({ id: "cast_budget" });
      expect(open?.evidence).toContain("slot-0, slot-1, slot-2, slot-3, slot-4");
      expect(open?.evidence).toContain("30 in all");
      expect(open?.evidence).toContain("25 an hour");
      // every candidate is on offer, and what else it takes is said
      expect(open?.candidates?.map((c) => c.value)).toEqual([
        "the first 4: slot-0, slot-1, slot-2, slot-3",
        "all 5: slot-0, slot-1, slot-2, slot-3, slot-4",
        "none",
      ]);
      expect(open?.canTake).toContain("the names of the parts to bind now");
      expect(open?.proposed).toContain("the first 4");
    });

    it("binds the parts it was told to, lists the rest as skipped, and says who decided", async () => {
      const { answer, keys } = await runWith({
        bind: ["slot-0", "slot-1", "slot-2", "slot-3"],
        decidedBy: "person",
      });
      expect(keys).toEqual(["s0", "s1", "s2", "s3"]);
      // (the fake gives every slot the same plan, so the merge keeps one: what matters is who ran)
      expect(answer.slots.map((s) => s.data === "skipped")).toEqual([
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(answer.remaining.some((r) => r.startsWith("data: slot-4: not bound:"))).toBe(true);
      expect(answer.settled).toEqual([
        { id: "cast_budget", by: "person", value: "slot-0, slot-1, slot-2, slot-3" },
      ]);
    });

    it("takes any set of the parts, an empty one included, and no word means anything", async () => {
      const some = await runWith({ bind: ["slot-4", "slot-1"] });
      expect(some.keys).toEqual(["s1", "s4"]);
      expect(some.answer.settled[0]).toMatchObject({ by: "agent", value: "slot-1, slot-4" });
      const none = await runWith({ bind: [], decidedBy: "memory" });
      expect(none.keys).toEqual([]);
      expect(none.answer.slots.every((s) => s.data === "skipped")).toBe(true);
      expect(none.answer.settled).toEqual([{ id: "cast_budget", by: "memory", value: "none" }]);
      // "all" is not a part of the frame: a decision is names, never a word code reads
      await expect(runWith({ bind: ["all"] })).rejects.toThrow(/not a part of this frame/);
    });

    it("binds every part, with nothing to settle, when an hour covers them", async () => {
      const { build } = fake();
      const ran: string[] = [];
      const answer = (await build(
        async (child) => {
          ran.push(child.spec.id);
          return child.spec.id === "frame-match" ? frame : bound("sq", "h");
        },
        { exportId: EXPORT, project: "default" },
      )) as { slots: unknown[]; settled: unknown[] };
      expect(ran).not.toContain(settleBudget.spec.id);
      expect(answer.slots).toHaveLength(2);
      expect(answer.settled).toEqual([]);
    });
  });

  describe("the step that settles it: its model asks, and a fact memory holds answers with no person", () => {
    const parts = ["slot-0", "slot-1", "slot-2", "slot-3", "slot-4"];
    const open: OpenItem = {
      id: "cast_budget",
      about: "which parts of this frame to bind to Cast data in this pass",
      evidence: "5 parts show data; Cast's hour covers about 4",
      canTake: "bind: the names of the parts to bind now",
    };
    const ask = {
      toolCalls: [
        {
          name: "ask",
          arguments: {
            questions: [
              {
                id: "cast_budget",
                question: "Which parts should I bind now?",
                why: "Five parts show data; Cast's hour covers about four",
                kind: "choice",
                options: [
                  { value: "first4", label: "The first four", description: "" },
                  { value: "all", label: "All five", description: "" },
                ],
                allowOther: true,
                proposed: ["first4"],
                remember: "club",
                fact: "cast.budget",
              },
            ],
          },
        },
      ],
    };
    const settle = async (finals: unknown[]) => {
      const asked: unknown[] = [];
      const sink = createMemorySink();
      const model = createScriptedModel([
        ask,
        ...finals.map((f) => ({ toolCalls: [{ name: "final", arguments: f }] })),
      ]);
      const result = await runLocal({
        // the step as the workflow runs it: its spec, its answer's shape and its check
        agent: settleBudget.definition,
        input: { open, parts },
        tenantId: "demo-cricket",
        tools: [],
        client: model,
        models: scriptedModelConfig(),
        context: async () => ({ text: "", recalled: "", tokens: 0, sources: [] }),
        // a person is never asked: the club's active fact answers it
        responder: async (req) => {
          asked.push(req);
          return { pending: true };
        },
        learned: {
          refine: async (qs) => qs,
          // an active `cast.budget` fact: the club's standing answer
          answer: async (qs) =>
            qs.every((q) => q.id === "cast_budget") ? { cast_budget: "first4" } : undefined,
        },
        runsDir: await mkdtemp(join(tmpdir(), "dugout-sb-")),
        sinks: [sink],
        outputs: createMemoryOutputStore(),
        store: createMemoryRunStore(),
      });
      return { result, asked, events: sink.events, model };
    };

    it("asks memory under the item's id, and answers with the parts' names, by memory", async () => {
      const { result, asked, events, model } = await settle([
        { bind: ["slot-0", "slot-1"], decidedBy: "memory", why: "the club binds the first" },
      ]);
      expect(result).toMatchObject({
        status: "completed",
        output: { bind: ["slot-0", "slot-1"], decidedBy: "memory" },
      });
      expect(asked).toEqual([]);
      // the question went to memory, which answered it: no person was stopped for
      const answered = events.filter((e) => e.type === "question.answered");
      expect(answered).toHaveLength(1);
      expect(answered[0]?.data).toMatchObject({
        source: "memory",
        answers: { cast_budget: "first4" },
      });
      // what the club answers is a fact: the question says so, for memory to learn it
      const question = events.find((e) => e.type === "question.asked")?.data.questions[0];
      expect(question?.about).toMatchObject({ scope: "tenant", fact: "cast.budget" });
      // the open item reached the model as data
      expect(String(model.requests[0]?.messages[1]?.content)).toContain("Cast's hour covers");
    });

    it("refuses a word that is not a part's name, and takes the names", async () => {
      const { result, events } = await settle([
        { bind: ["all"], decidedBy: "agent", why: "all of them" },
        { bind: parts, decidedBy: "agent", why: "all of them" },
      ]);
      expect(events.filter((e) => e.type === "final.refused").map((e) => e.data.reason)).toEqual([
        "bind names all, which is not a part of this frame that shows data. The parts are: slot-0, slot-1, slot-2, slot-3, slot-4",
      ]);
      expect(result).toMatchObject({ status: "completed", output: { bind: parts } });
    });
  });

  it("hands over a frame of one slot as before, with a slots entry of one", async () => {
    const { build } = fake();
    const one = { ...frame, slots: [slot("fx", "the-road-ahead")] };
    const calls: unknown[] = [];
    const answer = await build(
      async (child, input, opts) => {
        calls.push([child.spec.id, input, opts]);
        return child.spec.id === "frame-match" ? one : bound("fx", "dugout_fixtures");
      },
      { exportId: EXPORT, project: "default" },
    );
    // bind gets the whole preview, no slot and no key
    expect(calls[1]).toEqual(["data-bind", { preview: frame.previewUrl }, { tries: 3 }]);
    expect(answer).toMatchObject({
      slots: [{ name: "the-road-ahead", data: "bound", hookId: "dugout_fixtures", bound: 5 }],
    });
  });
});

describe("mergeBindings", () => {
  const part = (name: string, src: string, key: string) => ({
    name,
    plan: { bind: [{ src, prop: "content", path: `${key}.x` }] },
    bag: { [key]: { x: 1 } },
  });
  it("puts plans and data side by side", () => {
    const m = mergeBindings([part("a", "n1", "fixtures"), part("b", "n2", "squad")]);
    expect(m.merged).toEqual(["a", "b"]);
    expect(m.plan.bind).toHaveLength(2);
    expect(Object.keys(m.bag)).toEqual(["fixtures", "squad"]);
  });
  it("refuses a plan that names a node another plan names, and data under a taken name", () => {
    const m = mergeBindings([
      part("a", "n1", "fixtures"),
      part("b", "n1", "squad"),
      part("c", "n3", "fixtures"),
    ]);
    expect(m.merged).toEqual(["a"]);
    expect(m.refused.map((r) => r.name)).toEqual(["b", "c"]);
    expect(m.refused[0]?.why).toMatch(/names n1, which the plan of a already binds/);
    expect(m.refused[1]?.why).toMatch(/"fixtures"/);
  });
});
