/**
 * LOAD MORE as config: the section's machine asks for the next page of the source it reads (a
 * request with `source`), the host adds it to the data with `addToSource` and draws the section
 * again, a Repeater with an open slice draws the new cards, and the button's `when` reads the data
 * and hides it on the last page. No code knows what LOAD MORE is: the tree says it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { FlatTree, MachineSpec } from "@fanos/dsl";
import { Render } from "../src/components/Render.js";

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

const text = (id: string, parent: string, content: string) => ({
  id,
  parent,
  idx: 0,
  type: "Text",
  src: `t:${id}`,
  props: { content, style: "type.body_sm_bold" },
});

/** A lead card bound by position, the rest as a list from the second item on, and LOAD MORE. */
const TREE: FlatTree = {
  schemaVersion: "1",
  nodes: [
    { id: "root", parent: null, idx: 0, type: "Stack", src: "s:root", props: { direction: "column", machine: MORE } },
    text("lead", "root", "{photos.galleries.0.title}"),
    { id: "rest", parent: "root", idx: 1, type: "Repeater", src: "r:rest", props: { over: "photos.galleries", as: "g", slice: [1] } },
    text("card", "rest", "{g.title}"),
    {
      id: "more",
      parent: "root",
      idx: 2,
      type: "Button",
      src: "b:more",
      props: {
        label: "LOAD MORE",
        when: { path: "photos.next", exists: true },
        on: { click: { send: "photos.more" } },
      },
    },
  ] as FlatTree["nodes"],
};

const page = (n: number, titles: string[], next: number | null) => ({
  galleries: titles.map((title, i) => ({ id: `${n}-${i}`, title })),
  next,
});
const PAGES: Record<number, ReturnType<typeof page>> = {
  1: page(1, ["A", "B", "C"], 2),
  2: page(2, ["D", "E"], 3),
  3: page(3, ["F"], null),
};

describe("LOAD MORE, written as a machine and a when", () => {
  let browser: Browser | undefined;
  let tab: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { hydrateRoot } from "react-dom/client";
          import { addToSource } from "@fanos/dsl/runtime";
          import { Render } from "./src/components/Render.tsx";
          import { configureRuntime } from "./src/client.tsx";
          window.fosCalls = [];
          let root, props;
          // the host: it holds the section's data, runs the source for the page asked for, adds it
          configureRuntime({
            load: async (source, input) => {
              window.fosCalls.push({ load: source, input });
              const answer = window.fosPages[input.pgnum];
              props = { ...props, data: { ...props.data, [source]: addToSource(props.data[source], answer) } };
              root.render(createElement(Render, props));
            },
          });
          window.fosHydrate = (id, p) => { props = p; root = hydrateRoot(document.getElementById(id), createElement(Render, p)); };`,
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
    const props = { tree: TREE, data: { photos: PAGES[1] } };
    await tab.setContent(`<div id="s">${renderToString(createElement(Render, props as never))}</div>`);
    await tab.evaluate((pages) => {
      (window as unknown as { fosPages: unknown }).fosPages = pages;
    }, PAGES);
    await tab.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await tab.evaluate((p) => (window as unknown as { fosHydrate: (id: string, p: unknown) => void }).fosHydrate("s", p), props);
  }, 60_000);

  afterAll(async () => browser?.close());

  const cards = () => tab.locator('[data-fos-id="card"]').allTextContents();
  const button = () => tab.locator('[data-fos-id="more"]');

  it("draws the first page: the lead by position, the rest as the list", async () => {
    expect(await tab.locator('[data-fos-id="lead"]').textContent()).toBe("A");
    expect(await cards()).toEqual(["B", "C"]);
    expect(await button().count()).toBe(1);
  });

  it("adds each next page under the cards, and hides LOAD MORE once the data has no next page", async () => {
    await button().click();
    await expect.poll(cards).toEqual(["B", "C", "D", "E"]);
    expect(await button().count()).toBe(1);
    await button().click();
    await expect.poll(cards).toEqual(["B", "C", "D", "E", "F"]);
    await expect.poll(() => button().count()).toBe(0);
    const calls = await tab.evaluate(() => (window as unknown as { fosCalls: unknown[] }).fosCalls);
    expect(calls).toEqual([
      { load: "photos", input: { pgnum: 2 } },
      { load: "photos", input: { pgnum: 3 } },
    ]);
    expect(errors).toEqual([]);
  });
});
