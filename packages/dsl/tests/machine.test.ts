/**
 * Section machines on XState v5: the header's user menu, the fan-preferences drawer whose picks
 * another section shows, a cart with rules, a SAVE that posts, and what the server hands the
 * browser. Each test drives the pure functions the renderer's runtime calls.
 */

import { describe, expect, it } from "vitest";
import {
  addMachine,
  createSystem,
  dispatch,
  evaluate,
  initialStep,
  machineIssues,
  machineSchema,
  pageValues,
  resumeSystem,
  restoreMachine,
  setPageValue,
  stateScope,
  step,
  systemIssues,
  systemSnapshot,
  type MachineSpec,
} from "../src/machine/index.js";

const v = (path: string) => ({ var: path });

/** The header's user menu: the arrow opens it, a press outside or Escape closes it, LOGOUT calls the host. */
const HEADER: MachineSpec = {
  states: {
    menu: {
      initial: "closed",
      states: {
        closed: { on: { "menu.toggle": "open" } },
        open: {
          on: {
            "menu.toggle": "closed",
            "menu.close": "closed",
            "key.escape": "closed",
            logout: { target: "closed", actions: [{ call: { action: "auth.logout" } }, { emit: { name: "logout_clicked" } }] },
          },
        },
      },
    },
  },
};

/** The fan-preferences page: owns the followed list, shares it, opens the drawer on the page. */
const PREFS: MachineSpec = {
  context: { followed: [], favourite: [] },
  computed: { favourites: { len: v("context.favourite") } },
  exports: { followed: v("context.followed") },
  requests: { save: { action: "fan_prefs.save" } },
  states: {
    save: {
      initial: "idle",
      states: {
        idle: { on: { "prefs.save": "saving" } },
        saving: {
          tags: ["busy"],
          invoke: {
            request: "save",
            input: { obj: { followed: v("context.followed"), favourite: v("context.favourite") } },
            onDone: { target: "saved", actions: [{ emit: { name: "prefs_saved", params: { count: { len: v("context.followed") } } } }] },
            onError: { target: "failed", actions: [{ assign: { error: v("event.error.message") } }] },
          },
        },
        saved: { after: { "3000": "idle" } },
        failed: { on: { "prefs.save": "saving" } },
      },
    },
  },
  on: {
    "select.open": { actions: [{ send: { event: "drawer.open", payload: { draft: v("context.followed") } } }] },
    "players.chosen": { actions: [{ assign: { followed: v("event.ids") } }] },
    "favourite.toggle": {
      // at most two favourites, and only of players followed
      guard: {
        and: [
          { includes: [v("context.followed"), v("event.id")] },
          { or: [{ includes: [v("context.favourite"), v("event.id")] }, { "<": [{ len: v("context.favourite") }, 2] }] },
        ],
      },
      actions: [{ assign: { favourite: { toggle: [v("context.favourite"), v("event.id")] } } }],
    },
  },
};

/** The drawer, another section: a draft of picks, committed to the page on its SAVE. */
const DRAWER: MachineSpec = {
  context: { draft: [], q: "" },
  states: {
    panel: {
      initial: "closed",
      states: {
        closed: { on: { "drawer.open": { target: "open", actions: [{ assign: { draft: v("event.draft"), q: "" } }] } } },
        open: {
          on: {
            "player.toggle": { actions: [{ assign: { draft: { toggle: [v("context.draft"), v("event.id")] } } }] },
            "search.input": { actions: [{ assign: { q: v("event.value") } }] },
            "drawer.save": { target: "closed", actions: [{ send: { event: "players.chosen", payload: { ids: v("context.draft") } } }] },
            "drawer.close": "closed",
            "key.escape": "closed",
          },
        },
      },
    },
  },
};

describe("a machine", () => {
  it("parses as JSON and starts in its initial states", () => {
    expect(machineSchema.safeParse(HEADER).success).toBe(true);
    expect(machineSchema.safeParse(PREFS).success).toBe(true);
    const { snapshot, effects } = initialStep(HEADER);
    expect(snapshot.value).toEqual({ menu: "closed" });
    expect(snapshot.active).toEqual(["menu", "menu.closed"]);
    expect(effects).toEqual([]);
  });

  it("opens and closes the user menu, and logs out through the host", () => {
    let s = initialStep(HEADER).snapshot;
    s = step(HEADER, s, { type: "menu.toggle" }).snapshot;
    expect(s.active).toContain("menu.open");
    s = step(HEADER, s, { type: "key.escape" }).snapshot;
    expect(s.active).toContain("menu.closed");
    s = step(HEADER, s, { type: "menu.toggle" }).snapshot;
    const out = step(HEADER, s, { type: "logout" });
    expect(out.snapshot.active).toContain("menu.closed");
    expect(out.effects).toEqual([
      { type: "call", action: "auth.logout", input: null },
      { type: "emit", name: "logout_clicked", params: {} },
    ]);
  });

  it("ignores an event no active state handles, unchanged", () => {
    const s = initialStep(HEADER).snapshot;
    const out = step(HEADER, s, { type: "logout" });
    expect(out.changed).toBe(false);
    expect(out.snapshot).toBe(s);
  });

  it("keeps a guard: two favourites at most, and only players followed", () => {
    let s = initialStep(PREFS).snapshot;
    s = step(PREFS, s, { type: "players.chosen", ids: ["a", "b", "c"] }).snapshot;
    for (const id of ["a", "b", "c", "z"]) s = step(PREFS, s, { type: "favourite.toggle", id }).snapshot;
    expect(s.context.favourite).toEqual(["a", "b"]);
    expect(s.computed.favourites).toBe(2);
    s = step(PREFS, s, { type: "favourite.toggle", id: "a" }).snapshot;
    expect(s.context.favourite).toEqual(["b"]);
  });

  it("makes a request on entering a state, and moves on its answer", () => {
    let s = step(PREFS, initialStep(PREFS).snapshot, { type: "players.chosen", ids: ["a"] }).snapshot;
    const saving = step(PREFS, s, { type: "prefs.save" });
    expect(saving.snapshot.tags).toEqual(["busy"]);
    expect(saving.effects).toEqual([
      { type: "request", id: "save.saving", request: "save", action: "fan_prefs.save", input: { followed: ["a"], favourite: [] } },
    ]);
    s = saving.snapshot;
    expect(s.invokes).toEqual(["save.saving"]);
    const done = step(PREFS, s, { type: "done.invoke.save.saving", output: { ok: true } });
    expect(done.snapshot.active).toContain("save.saved");
    expect(done.snapshot.invokes).toEqual([]);
    expect(done.effects).toContainEqual({ type: "emit", name: "prefs_saved", params: { count: 1 } });
    // and waits three seconds before it is idle again
    expect(done.effects).toContainEqual(expect.objectContaining({ type: "timer", ms: 3000 }));
    const timer = done.effects.find((e: { type: string }) => e.type === "timer") as { id: string };
    const idle = step(PREFS, done.snapshot, { type: timer.id });
    expect(idle.snapshot.active).toContain("save.idle");
  });

  it("drops an answer nobody waits for any more", () => {
    const s = step(PREFS, initialStep(PREFS).snapshot, { type: "prefs.save" }).snapshot;
    const failed = step(PREFS, s, { type: "error.invoke.save.saving", error: { message: "offline" } }).snapshot;
    expect(failed.active).toContain("save.failed");
    expect(failed.context.error).toBe("offline");
    const late = step(PREFS, failed, { type: "done.invoke.save.saving", output: {} });
    expect(late.changed).toBe(false);
  });

  it("runs actions on a condition", () => {
    const spec: MachineSpec = {
      context: { qty: 1, note: "" },
      on: {
        dec: {
          actions: [
            { if: { cond: { ">": [v("context.qty"), 1] }, then: [{ assign: { qty: { "-": [v("context.qty"), 1] } } }], else: [{ emit: { name: "min_reached" } }] } },
          ],
        },
      },
    };
    let out = step(spec, initialStep(spec).snapshot, { type: "dec" });
    expect(out.snapshot.context.qty).toBe(1);
    expect(out.effects).toEqual([{ type: "emit", name: "min_reached", params: {} }]);
    out = step(spec, { ...out.snapshot, context: { ...out.snapshot.context, qty: 3 } }, { type: "dec" });
    expect(out.snapshot.context.qty).toBe(2);
  });

  it("derives a state with always, and steps through a wizard to its end", () => {
    const spec: MachineSpec = {
      type: "compound",
      initial: "form",
      context: { step: 0 },
      states: {
        form: {
          initial: "one",
          states: {
            one: { on: { next: "two" } },
            two: { on: { next: "done", back: "one" } },
            done: { type: "final" },
          },
          onDone: "thanks",
        },
        thanks: {},
      },
    };
    let s = initialStep(spec).snapshot;
    s = step(spec, s, { type: "next" }).snapshot;
    s = step(spec, s, { type: "next" }).snapshot;
    expect(s.value).toBe("thanks");
  });

  it("is refused with a message when a target names no state", () => {
    expect(() => initialStep({ states: { a: { initial: "x", states: { x: { on: { go: "nowhere" } } } } } })).toThrow(/nowhere/);
  });
});

describe("a page of machines", () => {
  it("opens another section's drawer, and the drawer's picks reach the section that owns them", () => {
    let { system } = createSystem([
      { instance: "prefs", spec: PREFS },
      { instance: "drawer", spec: DRAWER },
    ]);
    system = dispatch(system, "prefs", { type: "players.chosen", ids: ["a"] }).system;
    // SELECT PLAYER: the page section asks for the drawer, with what is followed now as the draft
    system = dispatch(system, "prefs", { type: "select.open" }).system;
    expect(system.machines.drawer!.active).toContain("panel.open");
    expect(system.machines.drawer!.context.draft).toEqual(["a"]);
    // picks in the drawer are a draft: the page has not changed
    system = dispatch(system, "drawer", { type: "player.toggle", id: "b" }).system;
    system = dispatch(system, "drawer", { type: "player.toggle", id: "a" }).system;
    expect(pageValues(system).followed).toEqual(["a"]);
    // the drawer's SAVE commits them to the owner, and every section reads them as $page.followed
    system = dispatch(system, "drawer", { type: "drawer.save" }).system;
    expect(system.machines.drawer!.active).toContain("panel.closed");
    expect(pageValues(system).followed).toEqual(["b"]);
    expect(stateScope(system, "drawer").$page).toMatchObject({ followed: ["b"] });
  });

  it("offers a press sent to the page to every machine that handles it", () => {
    let { system } = createSystem([
      { instance: "header", spec: HEADER },
      { instance: "drawer", spec: DRAWER },
    ]);
    system = dispatch(system, "header", { type: "menu.toggle" }).system;
    system = dispatch(system, "drawer", { type: "drawer.open", draft: [] }).system;
    system = dispatch(system, null, { type: "key.escape" }).system;
    expect(system.machines.header!.active).toContain("menu.closed");
    expect(system.machines.drawer!.active).toContain("panel.closed");
  });

  it("lets a machine follow a value another section shares, with no event between them", () => {
    const strip: MachineSpec = {
      context: { page: 0 },
      // back to the first page whenever the squad toggle in another section changes
      on: { "page.changed": { guard: { includes: [v("event.keys"), "squad"] }, actions: [{ assign: { page: 0 } }] }, more: { actions: [{ assign: { page: { "+": [v("context.page"), 1] } } }] } },
      computed: { squad: { "??": [v("$page.squad"), "men"] } },
    };
    let { system } = createSystem([{ instance: "strip", spec: strip }], { page: { squad: "men" } });
    system = dispatch(system, "strip", { type: "more" }).system;
    expect(system.machines.strip!.context.page).toBe(1);
    system = setPageValue(system, "squad", "women").system;
    expect(system.machines.strip!.context.page).toBe(0);
    expect(system.machines.strip!.computed.squad).toBe("women");
  });

  it("keeps a cart: lines, quantities, a cap per item and a total, persisted", () => {
    const cart: MachineSpec = {
      context: { lines: [] },
      persist: { storage: "local", fields: ["lines"], key: "cart" },
      computed: {
        count: { sum: [v("context.lines"), v("it.qty")] },
        total: { round: [{ sum: [v("context.lines"), { "*": [v("it.qty"), v("it.price")] }] }, 2] },
      },
      exports: { cart_count: v("computed.count"), cart_ids: { map: [v("context.lines"), v("it.id")] } },
      on: {
        "cart.add": [
          {
            guard: { some: [v("context.lines"), { "==": [v("it.id"), v("event.id")] }] },
            actions: [
              {
                assign: {
                  lines: {
                    updateWhere: [v("context.lines"), { "==": [v("it.id"), v("event.id")] }, { set: [v("it"), "qty", { min: [{ "+": [v("it.qty"), 1] }, 5] }] }],
                  },
                },
              },
            ],
          },
          {
            actions: [
              { assign: { lines: { append: [v("context.lines"), { obj: { id: v("event.id"), price: v("event.price"), qty: 1 } }] } } },
              { emit: { name: "add_to_cart", params: { id: v("event.id"), value: v("event.price") } } },
            ],
          },
        ],
        "cart.remove": { actions: [{ assign: { lines: { removeWhere: [v("context.lines"), { "==": [v("it.id"), v("event.id")] }] } } }] },
      },
    };
    let { system } = createSystem([{ instance: "cart", spec: cart }]);
    let out = dispatch(system, "cart", { type: "cart.add", id: "shirt", price: 55 });
    expect(out.effects).toContainEqual({ type: "emit", instance: "cart", name: "add_to_cart", params: { id: "shirt", value: 55 } });
    expect(out.effects).toContainEqual({ type: "persist", instance: "cart", storage: "local", key: "cart", value: { lines: [{ id: "shirt", price: 55, qty: 1 }] } });
    system = out.system;
    for (let i = 0; i < 6; i++) system = dispatch(system, "cart", { type: "cart.add", id: "shirt", price: 55 }).system;
    system = dispatch(system, "cart", { type: "cart.add", id: "scarf", price: 12.5 }).system;
    expect(system.machines.cart!.computed).toEqual({ count: 6, total: 287.5 });
    expect(pageValues(system)).toMatchObject({ cart_count: 6, cart_ids: ["shirt", "scarf"] });
    out = dispatch(system, "cart", { type: "cart.remove", id: "shirt" });
    expect(pageValues(out.system).cart_count).toBe(1);
    // read back on another page
    const again = restoreMachine(createSystem([{ instance: "cart", spec: cart }]).system, "cart", { lines: [{ id: "scarf", price: 12.5, qty: 2 }] });
    expect(again.system.machines.cart!.computed.total).toBe(25);
  });

  it("hands the browser a snapshot it can take over, and the requests and delays to restart", () => {
    const server = dispatch(createSystem([{ instance: "prefs", spec: PREFS }], { user: { name: "Nicola" } }).system, "prefs", { type: "prefs.save" }).system;
    const wire = JSON.parse(JSON.stringify(systemSnapshot(server)));
    expect(wire.host.user).toEqual({ name: "Nicola" });
    // the browser: an empty page, then the section joins at the server's snapshot
    const browser = addMachine(createSystem([], { user: wire.host.user }).system, { instance: "prefs", spec: PREFS }, wire.machines.prefs).system;
    expect(browser.machines.prefs).toEqual(server.machines.prefs);
    expect(resumeSystem(browser)).toEqual([
      { type: "request", instance: "prefs", id: "save.saving", request: "save", action: "fan_prefs.save", input: { followed: [], favourite: [] } },
    ]);
  });

  it("reads the signed-in fan in a guard", () => {
    const spec: MachineSpec = {
      states: { menu: { initial: "closed", states: { closed: { on: { "menu.toggle": { target: "open", guard: { exists: v("$user.name") } } } }, open: {} } } },
    };
    const out = createSystem([{ instance: "h", spec }], { user: null });
    expect(dispatch(out.system, "h", { type: "menu.toggle" }).system.machines.h!.active).toContain("menu.closed");
    const signedIn = createSystem([{ instance: "h", spec }], { user: { name: "Sagar" } });
    expect(dispatch(signedIn.system, "h", { type: "menu.toggle" }).system.machines.h!.active).toContain("menu.open");
  });
});

describe("the expression language", () => {
  it("reads, computes and builds JSON", () => {
    const scope = { context: { items: [{ id: "a", n: 2 }, { id: "b", n: 3 }] }, event: { id: "b" } };
    expect(evaluate({ sum: [v("context.items"), v("it.n")] }, scope)).toBe(5);
    expect(evaluate({ find: [v("context.items"), { "==": [v("it.id"), v("event.id")] }] }, scope)).toEqual({ id: "b", n: 3 });
    expect(evaluate({ obj: { a: 1, b: { cat: ["x", v("event.id")] } } }, scope)).toEqual({ a: 1, b: "xb" });
    expect(evaluate({ lit: { var: "not read" } }, scope)).toEqual({ var: "not read" });
    expect(evaluate({ sort: [v("context.items"), v("it.n"), "desc"] }, scope)).toEqual([{ id: "b", n: 3 }, { id: "a", n: 2 }]);
  });

  it("refuses what is not an op, and never reads outside plain data", () => {
    expect(() => evaluate({ hack: [1] })).toThrow(/not an expression/);
    expect(() => evaluate({ a: 1, b: 2 })).toThrow(/not an expression/);
    expect(evaluate(v("context.__proto__"), { context: {} })).toBeNull();
    expect(evaluate(v("context.constructor"), { context: {} })).toBeNull();
  });

  it("stops a runaway expression", () => {
    const big = { map: [{ range: [1000] }, { map: [{ range: [1000] }, v("it")] }] };
    expect(() => evaluate(big)).toThrow(/too many steps/);
  });
});

describe("what the validator says", () => {
  it("passes the machines above", () => {
    for (const spec of [HEADER, PREFS, DRAWER]) expect(machineIssues(spec).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("names an unknown op, a root out of scope, a missing state and a field never started", () => {
    const issues = machineIssues({
      states: { a: { initial: "x", states: { x: { on: { go: { target: "y", guard: { magic: [1] }, actions: [{ assign: { later: v("context.n") } }] } } }, y: {} } } },
      computed: { n: v("event.n") },
    });
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/not an expression/);
    expect(messages).toMatch(/reads "event"/);
    expect(messages).toMatch(/assigns "later"/);
    expect(machineIssues({ states: { a: { initial: "x", states: { x: { on: { go: "nowhere" } } } } } })[0]!.message).toMatch(/nowhere/);
  });

  it("warns of a target in another region, a request with no onError, and a state nothing reaches", () => {
    const issues = machineIssues({
      requests: { save: { action: "prefs.save" } },
      states: {
        a: { initial: "x", states: { x: { on: { go: "#b.y" } }, lonely: {} } },
        b: { initial: "x", states: { x: {}, y: { invoke: { request: "save" } } } },
      },
    });
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/both regions start again/);
    expect(messages).toMatch(/give it onError/);
    expect(messages).toMatch(/nothing goes to "a.lonely"/);
  });

  it("refuses a page key two sections share, and names events and reads nobody answers", () => {
    const issues = systemIssues([
      { instance: "prefs", spec: PREFS },
      { instance: "other", spec: { exports: { followed: { lit: [] } }, on: { x: { actions: [{ send: { event: "nobody.listens" } }] } }, computed: { s: v("$page.squad") } } },
    ]);
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/"followed" is already shared by "prefs"/);
    expect(messages).toMatch(/nobody.listens/);
    expect(messages).toMatch(/\$page.squad/);
    expect(messages).toMatch(/drawer.open/);
  });
});
