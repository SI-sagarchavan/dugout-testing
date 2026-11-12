/**
 * Interaction: three sections on one page, each with its machine, drawn by the server and taken
 * over by the browser. The header's user menu (opens on the arrow, closes on a press outside or
 * Escape, logs out through the host), the fan-preferences section (SELECT PLAYER opens a drawer
 * another section draws; the players picked there show here; SAVE posts), and the drawer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import type { FlatTree, MachineSpec } from "@fanos/dsl";
import { Render } from "../src/components/Render.js";

const v = (path: string) => ({ var: path });
const text = (id: string, parent: string, idx: number, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  parent,
  idx,
  type: "Text",
  src: `t:${id}`,
  props: { content, style: "type.body_sm_bold", ...extra },
});

const MENU: MachineSpec = {
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

const isOpen = { path: "$state.active", has: "menu.open" };

const HEADER: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "header", parent: null, idx: 0, type: "Stack", src: "h:1", props: { direction: "row", machine: MENU } },
    { id: "trigger", parent: "header", idx: 0, type: "Box", src: "h:2", props: { on: { click: { send: "menu.toggle" } }, statesWhen: { expanded: isOpen }, when: { path: "$user", exists: true } } },
    text("name", "trigger", 0, "{$user.name}"),
    text("signin", "header", 1, "LOG IN", { when: { path: "$user", exists: false } }),
    { id: "panel", parent: "header", idx: 2, type: "Stack", src: "h:3", props: { when: isOpen, on: { outside: { send: "menu.close" } } } },
    text("profile", "panel", 0, "MY PROFILE"),
    { id: "logout", parent: "panel", idx: 1, type: "Box", src: "h:4", props: { on: { click: { send: "logout" } } } },
    text("logout_label", "logout", 0, "LOGOUT"),
  ],
} as FlatTree;

const PREFS: MachineSpec = {
  context: { followed: [] },
  computed: { following: { len: v("context.followed") } },
  exports: { followed: v("context.followed") },
  requests: { save: { action: "fan_prefs.save" } },
  states: {
    save: {
      initial: "idle",
      states: {
        idle: { on: { "prefs.save": "saving" } },
        saving: {
          invoke: {
            request: "save",
            input: { obj: { followed: v("context.followed") } },
            onDone: { target: "saved", actions: [{ emit: { name: "prefs_saved", params: { count: { len: v("context.followed") } } } }] },
            onError: "failed",
          },
        },
        saved: { on: { "prefs.save": "saving" } },
        failed: { on: { "prefs.save": "saving" } },
      },
    },
  },
  on: {
    "select.open": { actions: [{ send: { event: "drawer.open", payload: { draft: v("context.followed") } } }] },
    "players.chosen": { actions: [{ assign: { followed: v("event.ids") } }] },
  },
};

const PREFS_TREE: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "prefs", parent: null, idx: 0, type: "Stack", src: "p:1", props: { machine: PREFS } },
    { id: "select", parent: "prefs", idx: 0, type: "Box", src: "p:2", props: { on: { click: { send: "select.open" } } } },
    text("select_label", "select", 0, "SELECT PLAYER"),
    text("count", "prefs", 1, "{$state.computed.following} following"),
    { id: "list", parent: "prefs", idx: 2, type: "Stack", src: "p:3", props: {} },
    { id: "followed", parent: "list", idx: 0, type: "Repeater", src: "synthetic:p:3:0", props: { over: "squad", as: "p", follow: { list: "$state.context.followed", key: "id" } } },
    text("fcard", "followed", 0, "{p.name}"),
    { id: "save", parent: "prefs", idx: 3, type: "Box", src: "p:4", props: { on: { click: { send: "prefs.save" } } } },
    text("save_label", "save", 0, "SAVE"),
    text("saved", "prefs", 4, "Saved", { when: { path: "$state.active", has: "save.saved" } }),
  ],
} as FlatTree;

const DRAWER: MachineSpec = {
  context: { draft: [] },
  states: {
    panel: {
      initial: "closed",
      states: {
        closed: { on: { "drawer.open": { target: "open", actions: [{ assign: { draft: v("event.draft") } }] } } },
        open: {
          on: {
            "player.toggle": { actions: [{ assign: { draft: { toggle: [v("context.draft"), v("event.id")] } } }] },
            "drawer.save": { target: "closed", actions: [{ send: { event: "players.chosen", payload: { ids: v("context.draft") } } }] },
          },
        },
      },
    },
  },
};

const DRAWER_TREE: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "drawer", parent: null, idx: 0, type: "Stack", src: "d:1", props: { machine: DRAWER } },
    { id: "sheet", parent: "drawer", idx: 0, type: "Stack", src: "d:2", props: { when: { path: "$state.active", has: "panel.open" } } },
    { id: "rows", parent: "sheet", idx: 0, type: "Repeater", src: "synthetic:d:2:0", props: { over: "squad", as: "p" } },
    {
      id: "row",
      parent: "rows",
      idx: 0,
      type: "Box",
      src: "d:3",
      props: {
        on: { click: { send: "player.toggle", payload: { id: "{p.id}" } } },
        statesWhen: { active: { path: "$state.context.draft", hasPath: "p.id" } },
        states: { active: { surface: "surface.button" } },
      },
    },
    text("row_name", "row", 0, "{p.name}"),
    { id: "done", parent: "sheet", idx: 1, type: "Box", src: "d:4", props: { on: { click: { send: "drawer.save" } } } },
    text("done_label", "done", 0, "SAVE"),
  ],
} as FlatTree;

const DATA = {
  squad: [
    { id: "dw", name: "Danni Wyatt" },
    { id: "jv", name: "James Vince" },
    { id: "mb", name: "Maia Bouchier" },
  ],
};

const USER = { name: "Nicola", initials: "N" };

describe("sections with machines, drawn by the server", () => {
  it("draws each at its machine's first moment, and the signed-in fan", () => {
    const html = renderToStaticMarkup(createElement(Render, { tree: HEADER, user: USER }));
    expect(html).toContain("Nicola");
    expect(html).not.toContain("LOG IN");
    expect(html).not.toContain("MY PROFILE");
    expect(html).toMatch(/data-fos-id="trigger"[^>]*data-fos-on="[^"]*menu.toggle/);
    expect(html).toMatch(/data-fos-id="trigger"[^>]*aria-expanded="false"/);
    expect(html).toContain('data-fos-instance="header"');
  });

  it("draws a signed-out header for nobody", () => {
    const html = renderToStaticMarkup(createElement(Render, { tree: HEADER, user: null }));
    expect(html).toContain("LOG IN");
    expect(html).not.toContain("Nicola");
  });

  it("draws a followed list as the machine starts: empty", () => {
    const html = renderToStaticMarkup(createElement(Render, { tree: PREFS_TREE, data: DATA }));
    expect(html).toContain("0 following");
    expect(html).not.toContain("Danni Wyatt");
  });

  it("resolves each row's payload where it is drawn", () => {
    const html = renderToStaticMarkup(
      createElement(Render, { tree: { ...DRAWER_TREE, nodes: DRAWER_TREE.nodes.map((n) => (n.id === "sheet" ? { ...n, props: {} } : n)) }, data: DATA }),
    );
    expect(html).toContain("&quot;id&quot;:&quot;jv&quot;");
    expect(html).toMatch(/data-fos-looks=/);
    expect(html).toMatch(/data-fos-state="inactive"/);
  });
});

describe("sections with machines, in the browser", () => {
  let browser: Browser | undefined;
  let tab: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { hydrateRoot } from "react-dom/client";
          import { Render } from "./src/components/Render.tsx";
          import { configureRuntime } from "./src/client.tsx";
          window.fosCalls = [];
          configureRuntime({
            request: async (action, input) => { window.fosCalls.push({ request: action, input }); return { ok: true }; },
            call: (action, input) => window.fosCalls.push({ call: action, input }),
            track: (name, params) => window.fosCalls.push({ track: name, params }),
          });
          window.fosHydrate = (id, props) => hydrateRoot(document.getElementById(id), createElement(Render, props));`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      alias: { "@fanos/renderer/client": "./src/client.tsx" },
      plugins: [
        {
          name: "no-fs",
          setup(b) {
            b.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: "fs", namespace: "stub" }));
            b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents: "export const readFileSync = () => { throw new Error('no fs in a page'); };",
            }));
          },
        },
      ],
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "error",
    });
    browser = await chromium.launch();
    tab = await browser.newPage();
    tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    tab.on("pageerror", (e) => errors.push(e.message));
    const sections = [
      { id: "h", props: { tree: HEADER, user: USER } },
      { id: "p", props: { tree: PREFS_TREE, data: DATA } },
      { id: "d", props: { tree: DRAWER_TREE, data: DATA } },
    ];
    await tab.setContent(
      `<div id="outside" style="height:40px">elsewhere</div>` +
        sections.map((s) => `<div id="${s.id}">${renderToString(createElement(Render, s.props as never))}</div>`).join(""),
    );
    await tab.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await tab.evaluate((all) => {
      const w = window as unknown as { fosHydrate: (id: string, p: unknown) => void };
      for (const s of all) w.fosHydrate(s.id, s.props);
    }, sections);
  }, 60_000);

  afterAll(async () => browser?.close());

  const shown = (id: string) => tab.locator(`[data-fos-id="${id}"]`).count();
  const calls = () => tab.evaluate(() => (window as unknown as { fosCalls: unknown[] }).fosCalls);

  it("opens the user menu on the arrow, and closes it on a press outside and on Escape", async () => {
    expect(await shown("panel")).toBe(0);
    await tab.locator('[data-fos-id="trigger"]').click();
    expect(await shown("panel")).toBe(1);
    expect(await tab.locator('[data-fos-id="trigger"]').getAttribute("aria-expanded")).toBe("true");
    // the arrow again toggles it shut: a press its own section took is not a press outside
    await tab.locator('[data-fos-id="trigger"]').click();
    expect(await shown("panel")).toBe(0);
    await tab.locator('[data-fos-id="trigger"]').click();
    await tab.locator("#outside").click();
    expect(await shown("panel")).toBe(0);
    await tab.locator('[data-fos-id="trigger"]').click();
    await tab.keyboard.press("Escape");
    expect(await shown("panel")).toBe(0);
  });

  it("logs out through the host, and says so to tracking", async () => {
    await tab.locator('[data-fos-id="trigger"]').click();
    await tab.locator('[data-fos-id="logout"]').click();
    expect(await shown("panel")).toBe(0);
    expect(await calls()).toEqual([
      { call: "auth.logout", input: null },
      { track: "logout_clicked", params: {} },
    ]);
  });

  it("opens another section's drawer, keeps the picks as a draft, and shows them here on its SAVE", async () => {
    expect(await shown("sheet")).toBe(0);
    await tab.locator('[data-fos-id="select"]').click();
    expect(await shown("sheet")).toBe(1);
    const row = (n: number) => tab.locator('[data-fos-id="row"]').nth(n);
    await row(0).click();
    await row(2).click();
    expect(await row(0).getAttribute("data-fos-state")).toBe("active");
    expect(await row(1).getAttribute("data-fos-state")).toBe("inactive");
    // a draft: the page has not changed yet
    expect(await tab.locator('[data-fos-id="fcard"]').count()).toBe(0);
    await tab.locator('[data-fos-id="done"]').click();
    expect(await shown("sheet")).toBe(0);
    expect(await tab.locator('[data-fos-id="fcard"]').allTextContents()).toEqual(["Danni Wyatt", "Maia Bouchier"]);
    expect(await tab.locator('[data-fos-id="count"]').textContent()).toBe("2 following");
  });

  it("posts the SAVE through the host and shows what it answered", async () => {
    await tab.locator('[data-fos-id="save"]').click();
    await tab.locator('[data-fos-id="saved"]').waitFor();
    const all = (await calls()) as Array<Record<string, unknown>>;
    expect(all).toContainEqual({ request: "fan_prefs.save", input: { followed: ["dw", "mb"] } });
    expect(all).toContainEqual({ track: "prefs_saved", params: { count: 2 } });
    expect(errors).toEqual([]);
  });
});
