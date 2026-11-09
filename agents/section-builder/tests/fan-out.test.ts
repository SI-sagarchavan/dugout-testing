import type { ControlPlane } from "@dugout/agent-frame-match";
import { AwaitingAnswers } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { makePipeline } from "../src/agent.ts";
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
  const pipeline = makePipeline({ plane: () => plane, dsl: async () => dsl as never });
  return { pipeline, uploads };
};

describe("section-builder on a frame of two slots", () => {
  it("binds each slot with its own run, merges the plans and publishes once", async () => {
    const { pipeline, uploads } = fake();
    const calls: Array<{ agent: string; input: unknown; key?: string | undefined }> = [];
    const answer = await pipeline.run(
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

  it("leaves a slot with no data as published, and binds the other", async () => {
    const { pipeline } = fake();
    const ran: string[] = [];
    const answer = await pipeline.run(
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
    const { pipeline } = fake();
    const answer = await pipeline.run(
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

  it("fails the pass, keeping the others, when a slot has tries left", async () => {
    const { pipeline, uploads } = fake();
    await expect(
      pipeline.run(
        async (child, input) => {
          if (child.spec.id === "frame-match") return frame;
          const id = (input as { slot: { id: string } }).slot.id;
          if (id === "fx") throw new Error("data-bind failed. Try 1 of 3; it may be called again");
          return bound(id, "dugout_squad");
        },
        { exportId: EXPORT, project: "default" },
      ),
    ).rejects.toThrow(/Try 1 of 3/);
    // nothing is published until every slot is bound or out of tries
    expect(uploads).toEqual([]);
  });

  it("passes a pause for a person up, not swallowing it as a failed slot", async () => {
    const { pipeline } = fake();
    const asking = new AwaitingAnswers([], ["child"]);
    await expect(
      pipeline.run(
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
    const runWith = async (answers?: Record<string, string>) => {
      const { pipeline } = fake();
      const keys: string[] = [];
      const answer = await pipeline.run(
        async (child, _input, opts) => {
          if (child.spec.id === "frame-match") return { ...frame, slots: many };
          keys.push(opts?.key ?? "");
          return bound("fx", "h");
        },
        { exportId: EXPORT, project: "default" },
        answers ? { answered: { by: "sam", answers } } : {},
      );
      return {
        answer: answer as { slots: Array<{ name: string; data: string }>; remaining: string[] },
        keys,
      };
    };

    it("asks a person once, before binding any, and proposes the first few", async () => {
      const asked = await runWith().catch((e: unknown) => e);
      expect(asked).toBeInstanceOf(AwaitingAnswers);
      const [q] = (asked as AwaitingAnswers).questions;
      expect(q).toMatchObject({ id: "cast_budget", kind: "choice", proposed: ["first"] });
      expect(q?.why).toContain("slot-0, slot-1, slot-2, slot-3, slot-4");
    });

    it("binds the first four when that is the answer, and lists the rest as skipped", async () => {
      const { answer, keys } = await runWith({ cast_budget: "first" });
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
    });

    it("binds them all, or none, as the person chose", async () => {
      expect((await runWith({ cast_budget: "all" })).keys).toHaveLength(5);
      const none = await runWith({ cast_budget: "none" });
      expect(none.keys).toEqual([]);
      expect(none.answer.slots.every((s) => s.data === "skipped")).toBe(true);
    });
  });

  it("hands over a frame of one slot as before, with a slots entry of one", async () => {
    const { pipeline } = fake();
    const one = { ...frame, slots: [slot("fx", "the-road-ahead")] };
    const calls: unknown[] = [];
    const answer = await pipeline.run(
      async (child, input, opts) => {
        calls.push([child.spec.id, input, opts]);
        return child.spec.id === "frame-match" ? one : bound("fx", "dugout_fixtures");
      },
      { exportId: EXPORT, project: "default" },
    );
    // bind gets the whole preview, no slot and no key
    expect(calls[1]).toEqual(["data-bind", { preview: frame.previewUrl }, undefined]);
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
