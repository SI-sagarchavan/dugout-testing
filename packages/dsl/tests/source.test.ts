/**
 * More of a data source (LOAD MORE): a machine's request names a source the section reads, the
 * host runs it again for the next page, and what it answers is added to what the page holds of it.
 */

import { describe, expect, it } from "vitest";
import { addToSource } from "../src/source.js";
import { initialStep, machineIssues, step, type MachineSpec } from "../src/machine/index.js";
import { checkMachine } from "../src/machine/tree.js";
import { tinyTree } from "./helpers.js";

/** What a model writes for LOAD MORE: which page it asked for, a request for the next one. */
const MORE: MachineSpec = {
  context: { page: 1 },
  requests: { next_page: { source: "photos" } },
  states: {
    more: {
      initial: "idle",
      states: {
        idle: { on: { "photos.more": "loading" } },
        loading: {
          tags: ["loading"],
          invoke: {
            request: "next_page",
            input: { obj: { pgnum: { "+": [{ var: "context.page" }, 1] } } },
            onDone: { target: "idle", actions: [{ assign: { page: { "+": [{ var: "context.page" }, 1] } } }] },
            onError: "idle",
          },
        },
      },
    },
  },
};

describe("adding more of a source", () => {
  it("appends lists, adds to objects key by key, and takes the answer's other values", () => {
    const held = { galleries: [{ id: 1 }, { id: 2 }], next: 2, total: 5 };
    expect(addToSource(held, { galleries: [{ id: 3 }], next: null })).toEqual({
      galleries: [{ id: 1 }, { id: 2 }, { id: 3 }],
      next: null,
      total: 5,
    });
    expect(addToSource({ a: { list: [1] } }, { a: { list: [2], page: 2 } })).toEqual({ a: { list: [1, 2], page: 2 } });
  });
});

describe("a request for more of a source", () => {
  it("asks the runtime for the source with the next page, and moves on when it is added", () => {
    const s = initialStep(MORE).snapshot;
    const loading = step(MORE, s, { type: "photos.more" });
    expect(loading.snapshot.tags).toEqual(["loading"]);
    expect(loading.effects).toEqual([
      { type: "request", id: "more.loading", request: "next_page", source: "photos", input: { pgnum: 2 } },
    ]);
    const done = step(MORE, loading.snapshot, { type: "done.invoke.more.loading", output: null });
    expect(done.snapshot.active).toContain("more.idle");
    expect(done.snapshot.context.page).toBe(2);
    // the next press asks for the page after
    expect(step(MORE, done.snapshot, { type: "photos.more" }).effects[0]).toMatchObject({ input: { pgnum: 3 } });
  });

  it("is a host action or a source, never both or neither", () => {
    expect(machineIssues({ ...MORE, requests: { next_page: { source: "photos", action: "a.b" } } }).map((i) => i.message).join()).toMatch(
      /one of the two/,
    );
    expect(machineIssues({ ...MORE, requests: { next_page: {} } }).length).toBeGreaterThan(0);
    expect(machineIssues(MORE).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("names a source the section reads (S18)", () => {
    const tree = (source: string) =>
      tinyTree([
        { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: { machine: { ...MORE, requests: { next_page: { source } } } } },
        { id: "list", parent: "root", idx: 0, type: "Repeater", src: "1:2", props: { over: "photos.galleries", as: "g" } },
        { id: "title", parent: "list", idx: 0, type: "Text", src: "1:3", props: { content: "{g.title}" } },
        {
          id: "more",
          parent: "root",
          idx: 1,
          type: "Button",
          src: "1:4",
          props: { label: "LOAD MORE", when: { path: "photos.next", exists: true }, on: { click: { send: "photos.more" } } },
        },
      ]);
    expect(checkMachine(tree("photos"))).toEqual([]);
    expect(checkMachine(tree("videos")).map((i) => i.message)).toEqual([
      '"next_page" loads more of "videos", which no node of this section reads: name the data source its refs start with',
    ]);
  });
});
