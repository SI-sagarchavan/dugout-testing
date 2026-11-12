/**
 * A behaviour the model writes itself, in the DSL: LOAD MORE as a machine that asks for the next
 * page of the section's source, and props on the button (what a press sends, when it is drawn).
 * Checked with the DSL's own code: S18, and the machine run event by event.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";
import { beforeAll, describe, expect, it } from "vitest";
import { type CheckDsl, check } from "../src/check.ts";
import { type Behaviours, compile } from "../src/compile.ts";
import { buttonsOf, sourcesOf } from "../src/tools.ts";
import type { Plan, Tree } from "../src/tree.ts";

let dsl: CheckDsl;
beforeAll(async () => {
  dsl = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/dsl/dist/index.js")).href
  )) as CheckDsl;
});

const TREE: Tree = {
  schemaVersion: "1",
  nodes: [
    { id: "root", parent: null, idx: 0, type: "Stack", src: "1:root", props: {} },
    { id: "lead", parent: "root", idx: 0, type: "Text", src: "1:lead", props: { content: "Lead" } },
    { id: "row", parent: "root", idx: 1, type: "Stack", src: "1:row", props: {} },
    { id: "card", parent: "row", idx: 0, type: "Text", src: "1:card", props: { content: "Card" } },
    {
      id: "more",
      parent: "root",
      idx: 2,
      type: "Button",
      src: "1:more",
      props: { label: "LOAD MORE" },
    },
  ],
} as Tree;

const PLAN: Plan = {
  bind: [{ src: "1:lead", prop: "content", path: "photos.galleries.0.title" }],
  collapse: [
    {
      over: "photos.galleries",
      as: "g",
      members: ["1:card"],
      shape: "varies",
      slice: [1],
      fields: [{ src: "1:card", prop: "content", path: "title" }],
    },
  ],
  set: [],
} as unknown as Plan;

const DATA = { photos: { galleries: [{ title: "A" }, { title: "B" }], next: 2 } };

const none = { toggles: [], show: [], restyle: [], search: [], scroll: [] };
const LOAD_MORE: Behaviours = {
  ...none,
  machine: {
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
              input: { obj: { page: { "+": [{ var: "context.page" }, 1] } } },
              onDone: {
                target: "idle",
                actions: [{ assign: { page: { "+": [{ var: "context.page" }, 1] } } }],
              },
              onError: "idle",
            },
          },
        },
      },
    },
  },
  props: [
    { src: "1:more", prop: "on", value: { click: { send: "photos.more" } } },
    { src: "1:more", prop: "when", value: { path: "photos.next", exists: true } },
  ],
};

describe("a behaviour the model writes in the DSL", () => {
  it("shows the model the section's sources, where a list says how it pages, and its buttons", () => {
    expect(
      sourcesOf(DATA, { data: [{ as: "photos", hookId: "dugout_x", input: { page: "1" } }] }),
    ).toEqual([
      {
        as: "photos",
        hookId: "dugout_x",
        input: { page: "1" },
        holds: { galleries: "list of 2", next: 2 },
      },
    ]);
    expect(buttonsOf(TREE)).toEqual([{ src: "1:more", label: "LOAD MORE" }]);
  });

  it("puts the machine on the root and the props in the plan, and runs each press", () => {
    const compiled = compile(TREE, PLAN, LOAD_MORE);
    expect(compiled.problems).toEqual([]);
    expect(compiled.tree.nodes[0]?.props.machine).toEqual(LOAD_MORE.machine);
    expect(compiled.plan.set).toContainEqual({
      src: "1:more",
      prop: "when",
      value: { path: "photos.next", exists: true },
    });
    const checked = check(compiled, LOAD_MORE, DATA, dsl);
    expect(checked.problems).toEqual([]);
    expect(checked.states).toEqual([
      "at first: more, more.idle; more drawn",
      'photos.more (from more click): more, more.loading [loading]; asks for more of photos with {"page":2}',
      `after next_page answers: more, more.idle; photos's next page is added to the data (lists appended, the rest replaced); more reads {"path":"photos.next","exists":true}, which each page of photos answers anew`,
    ]);
  });

  it("reports what the DSL refuses: an event nobody handles, a source the section does not read", () => {
    const wrong: Behaviours = {
      ...LOAD_MORE,
      machine: { ...LOAD_MORE.machine, requests: { next_page: { source: "videos" } } },
      props: [{ src: "1:more", prop: "on", value: { click: { send: "photos.next_page" } } }],
    };
    const checked = check(compile(TREE, PLAN, wrong), wrong, DATA, dsl);
    expect(checked.problems.join("\n")).toMatch(
      /sends "photos.next_page", which the section's machine never handles/,
    );
    expect(checked.problems.join("\n")).toMatch(
      /loads more of "videos", which no node of this section reads/,
    );
  });

  it("refuses a prop on a layer the tree does not have", () => {
    const compiled = compile(TREE, PLAN, {
      ...none,
      props: [{ src: "9:9", prop: "when", value: { path: "x", exists: true } }],
    });
    expect(compiled.problems).toEqual(["when on 9:9: no layer of the tree has that src"]);
  });
});
