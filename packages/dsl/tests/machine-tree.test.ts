/**
 * S18 on whole trees, and a `when` split between the server and the browser.
 */

import { describe, expect, it } from "vitest";
import { checkMachine } from "../src/machine/tree.js";
import { splitLiveWhen } from "../src/machine/when.js";
import { evaluateWhen } from "../src/binding.js";
import type { FlatTree } from "../src/flat.js";

const tree = (nodes: Array<{ id: string; parent: string | null; type?: string; props: Record<string, unknown> }>): FlatTree => ({
  schemaVersion: "1.0.0",
  nodes: nodes.map((n, i) => ({ id: n.id, parent: n.parent, idx: nodes.filter((m, j) => j < i && m.parent === n.parent).length, type: n.type ?? "Box", src: `1:${i}`, props: n.props })),
});

const MENU = { states: { menu: { initial: "closed", states: { closed: { on: { "menu.toggle": "open" } }, open: { on: { "menu.toggle": "closed" } } } } } };

describe("S18", () => {
  it("passes a section whose nodes send what its machine handles and read what it has", () => {
    const issues = checkMachine(
      tree([
        { id: "root", parent: null, props: { machine: MENU } },
        { id: "arrow", parent: "root", props: { on: { click: { send: "menu.toggle" } }, statesWhen: { expanded: { path: "$state.active", has: "menu.open" } } } },
        { id: "open", parent: "root", props: { on: { click: { send: "drawer.open", to: "page" } } } },
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("names a machine off the root, an event nobody handles, and $state with no machine", () => {
    const messages = (t: FlatTree) => checkMachine(t).map((i) => i.message).join("\n");
    expect(messages(tree([{ id: "root", parent: null, props: {} }, { id: "x", parent: "root", props: { machine: MENU } }]))).toMatch(/on its root/);
    expect(messages(tree([{ id: "root", parent: null, props: { machine: MENU } }, { id: "x", parent: "root", props: { on: { click: { send: "menu.flip" } } } }]))).toMatch(/never handles/);
    expect(messages(tree([{ id: "root", parent: null, props: {} }, { id: "x", parent: "root", props: { on: { click: { send: "menu.toggle" } } } }]))).toMatch(/no machine/);
    expect(messages(tree([{ id: "root", parent: null, props: {} }, { id: "x", parent: "root", type: "Text", props: { content: "{$state.computed.n}" } }]))).toMatch(/has no machine/);
  });

  it("refuses a Repeater over state, and a follow of something that is not", () => {
    const messages = checkMachine(
      tree([
        { id: "root", parent: null, props: { machine: { context: { lines: [] } } } },
        { id: "r", parent: "root", type: "Repeater", props: { over: "$state.context.lines", as: "l" } },
        { id: "s", parent: "root", type: "Repeater", props: { over: "products", as: "p", follow: { list: "cart.lines", key: "id" } } },
      ]),
    )
      .map((i) => i.message)
      .join("\n");
    expect(messages).toMatch(/follow the list in state/);
    expect(messages).toMatch(/is not state/);
  });

  it("carries the machine's own issues", () => {
    const issues = checkMachine(tree([{ id: "root", parent: null, props: { machine: { states: { a: { initial: "x", states: { x: { on: { go: "nope" } } } } } } } }]));
    expect(issues[0]).toMatchObject({ code: "S18", severity: "error", nodeId: "root" });
  });
});

describe("a when split between server and browser", () => {
  const data = { p: { id: "jv", team: "men" }, $user: { name: "Nicola" } };

  it("decides data and the host now, and leaves state to the browser", () => {
    const out = splitLiveWhen([{ path: "p.team", eq: "men" }, { path: "$user.name", exists: true }, { path: "$state.active", has: "menu.open" }], data);
    expect(out.now).toEqual([{ path: "p.team", eq: "men" }, { path: "$user.name", exists: true }]);
    expect(out.live).toEqual([{ path: "$state.active", has: "menu.open" }]);
  });

  it("makes an item's field a value, so the browser needs only the state", () => {
    expect(splitLiveWhen({ path: "$page.followed", hasPath: "p.id" }, data).live).toEqual([{ path: "$page.followed", has: "jv" }]);
    expect(splitLiveWhen({ path: "p.id", eqPath: "$state.context.current" }, data).live).toEqual([{ path: "$state.context.current", eq: "jv" }]);
  });

  it("draws a row the fan has not picked, and searches its text", () => {
    const lacks = splitLiveWhen({ path: "$state.context.selected", lacksPath: "p.id" }, data).live;
    expect(lacks).toEqual([{ path: "$state.context.selected", lacks: "jv" }]);
    const scope = (selected: string[]) => ({ $state: { context: { selected } } });
    expect(evaluateWhen(lacks, scope([]))).toBe(true);
    expect(evaluateWhen(lacks, scope(["jv"]))).toBe(false);
    expect(splitLiveWhen({ path: "p.name", containsPath: "$state.context.q" }, { p: { name: "James Vince" } }).live).toEqual([
      { path: "$state.context.q", within: "James Vince" },
    ]);
  });
});
