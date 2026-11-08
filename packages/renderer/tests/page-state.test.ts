/**
 * Page state: one section's options choose, another section's `when` reads the choice. Two trees,
 * two Render roots on one page, as a header with a WOMEN | MEN toggle and the squad strip under it
 * are. Checked as markup, then in Chromium with both hydrated and an option pressed.
 */

import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { pageDefaults, type FlatTree } from "@fanos/dsl";
import { Render } from "../src/components/Render.js";

const option = (id: string, idx: number, value: string, label: string, initial = false) => [
  {
    id,
    parent: "bar",
    idx,
    type: "Stack",
    src: `1:${idx + 2}`,
    props: {
      select: { key: "squad", value, ...(initial ? { initial: true } : {}) },
      states: { active: { surface: "surface.button" } },
    },
  },
  { id: `${id}_label`, parent: id, idx: 0, type: "Text", src: `1:${idx + 10}`, props: { content: label, style: "type.body_sm_bold" } },
];

/** The header: WOMEN | MEN, MEN drawn selected. */
const HEADER: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "bar", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row" } },
    ...option("women", 0, "women", "WOMEN"),
    ...option("men", 1, "men", "MEN", true),
  ],
} as FlatTree;

/** The strip: every player, each drawn while their team is the chosen one; and a note per team. */
const STRIP: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "strip", parent: null, idx: 0, type: "Stack", src: "2:1", props: { direction: "row" } },
    { id: "players", parent: "strip", idx: 0, type: "Repeater", src: "synthetic:2:1:1", props: { over: "squad.items", as: "p" } },
    {
      id: "card",
      parent: "players",
      idx: 0,
      type: "Text",
      src: "2:2",
      props: { content: "{p.name}", style: "type.body_sm_bold", when: { path: "p.team", eqPath: "_page.squad" } },
    },
    {
      id: "women_note",
      parent: "strip",
      idx: 1,
      type: "Text",
      src: "2:3",
      props: { content: "Women's squad", style: "type.body_sm_bold", when: { path: "_page.squad", eq: "women" } },
    },
  ],
} as FlatTree;

const DATA = {
  squad: {
    items: [
      { name: "Danni Wyatt", team: "women" },
      { name: "James Vince", team: "men" },
      { name: "Maia Bouchier", team: "women" },
    ],
  },
};

/** Both sections, as a host draws a page: each told where the page's choices start. */
const page = (render: typeof renderToString = renderToStaticMarkup) => {
  const start = pageDefaults([HEADER, STRIP]);
  return [
    render(createElement(Render, { tree: HEADER, page: start })),
    render(createElement(Render, { tree: STRIP, data: DATA, page: start })),
  ].join("");
};

describe("a page choice, drawn by the server", () => {
  it("draws each option in its state, the one drawn selected active", () => {
    const html = page();
    expect(html).toMatch(/data-fos-id="men"[^>]*data-fos-select="squad"[^>]*data-fos-value="men"[^>]*data-fos-state="active"[^>]*aria-selected="true"/);
    expect(html).toMatch(/data-fos-id="women"[^>]*data-fos-state="inactive"[^>]*aria-selected="false"/);
    expect(html).toContain('role="tab"');
  });

  it("draws another section at the choice the page starts at", () => {
    const html = page();
    expect(html).toContain("James Vince");
    expect(html).not.toContain("Danni Wyatt");
    expect(html).not.toContain("Women&#x27;s squad");
  });

  it("starts at the host's choice over the one drawn", () => {
    const html = renderToStaticMarkup(createElement(Render, { tree: STRIP, data: DATA, page: { squad: "women" } }));
    expect(html).toContain("Danni Wyatt");
    expect(html).toContain("Maia Bouchier");
    expect(html).not.toContain("James Vince");
  });
});

describe("a page choice, in the browser", () => {
  let browser: Browser | undefined;
  afterAll(async () => browser?.close());

  it("chooses on a press, and every section that reads it follows", async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { hydrateRoot } from "react-dom/client";
          import { Render } from "./src/components/Render.tsx";
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
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const start = pageDefaults([HEADER, STRIP]);
    await tab.setContent(
      `<div id="header">${renderToString(createElement(Render, { tree: HEADER, page: start }))}</div>` +
        `<div id="strip">${renderToString(createElement(Render, { tree: STRIP, data: DATA, page: start }))}</div>`,
    );
    await tab.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await tab.evaluate(
      ({ header, strip, data, start }) => {
        const w = window as unknown as { fosHydrate: (id: string, p: unknown) => void };
        w.fosHydrate("header", { tree: header, page: start });
        w.fosHydrate("strip", { tree: strip, data, page: start });
      },
      { header: HEADER, strip: STRIP, data: DATA, start },
    );
    const state = (id: string) => tab.locator(`[data-fos-id="${id}"]`).getAttribute("data-fos-state");
    const names = () => tab.locator('[data-fos-id="card"]').allTextContents();

    expect(await names()).toEqual(["James Vince"]);
    await tab.locator('[data-fos-id="women"]').click();
    expect(await state("women")).toBe("active");
    expect(await state("men")).toBe("inactive");
    expect(await names()).toEqual(["Danni Wyatt", "Maia Bouchier"]);
    expect(await tab.locator('[data-fos-id="women_note"]').count()).toBe(1);

    // the keyboard moves along the choice
    await tab.locator('[data-fos-id="women"]').focus();
    await tab.keyboard.press("ArrowRight");
    expect(await state("men")).toBe("active");
    expect(await names()).toEqual(["James Vince"]);
    expect(errors).toEqual([]);
  });
});
