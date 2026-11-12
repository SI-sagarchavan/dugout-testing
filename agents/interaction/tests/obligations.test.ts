import { memoryRunState } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { verifyFinal } from "../src/agent.ts";
import { OBLIGED, obligedOf } from "../src/tools.ts";
import type { Tree } from "../src/tree.ts";

const TREE: Tree = {
  nodes: [
    { id: "r", parent: null, idx: 0, type: "Stack", src: "root", props: {} },
    { id: "m", parent: "r", idx: 0, type: "Button", src: "more", props: { label: "LOAD MORE" } },
  ],
} as Tree;
const PLAN = { collapse: [{ over: "galleries.galleries", as: "g", members: ["c"], slice: [7] }] };
// on its last page: what the data holds today is no reason to leave LOAD MORE unwired
const DATA = { galleries: { galleries: [{ id: 1 }], next: null } };
const ANSWER = { previewUrl: "", treeArtifactId: "", behaviours: [], settled: [], remaining: [] };

describe("the paging obligation on final", () => {
  it("refuses a final that leaves a paged list unwired", () => {
    const state = memoryRunState();
    state.set(OBLIGED, obligedOf(TREE, PLAN as never, DATA));
    expect(verifyFinal(ANSWER, { state })).toMatch(/galleries pages/);
  });

  it("takes a listed reason for leaving it", () => {
    const state = memoryRunState();
    state.set(OBLIGED, obligedOf(TREE, PLAN as never, DATA));
    const unmet = [{ source: "galleries", reason: "nothing-asks", why: "no button" }];
    expect(verifyFinal({ ...ANSWER, unmet }, { state })).toBeUndefined();
  });

  it("is met by a machine that asks the source and a button drawn on its next", () => {
    const wired: Tree = {
      nodes: [
        {
          ...TREE.nodes[0],
          props: { machine: { requests: { next_page: { source: "galleries" } } } },
        },
        TREE.nodes[1],
      ],
    } as Tree;
    const plan = {
      ...PLAN,
      set: [{ src: "more", prop: "when", value: { path: "galleries.next", exists: true } }],
    };
    expect(obligedOf(wired, plan as never, DATA)).toEqual([]);
  });
});
