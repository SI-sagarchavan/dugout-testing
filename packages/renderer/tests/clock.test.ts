/**
 * A node's `clock`: the server draws the digits as they read at render time, and the browser
 * ticks them. Checked as markup, then in Chromium with the page hydrated and time moved on by
 * Playwright's clock.
 */

import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import type { FlatTree } from "@fanos/dsl";
import { Render } from "../src/components/Render.js";

const KICKOFF = "2026-11-17T14:30:00+00:00";
/** 2 days, 2 hours, 12 minutes and 33 seconds before kick-off. */
const NOW = Date.parse("2026-11-15T12:17:27Z");

const text = (id: string, idx: number, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  parent: "card",
  idx,
  type: "Text",
  src: `1:${idx + 10}`,
  props: { content, style: "type.body_md_bold", ...extra },
});

/** A card that counts down to its match, and says LIVE once it has started. */
const TREE: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    {
      id: "card",
      parent: null,
      idx: 0,
      type: "Stack",
      src: "1:1",
      props: { clock: { to: "{match.start_time}", as: "countdown", units: ["d", "h", "m", "s"] } },
    },
    text("days", 0, "{countdown.d | pad:2}", { when: { path: "countdown.past", eq: false } }),
    text("secs", 1, "{countdown.s | pad:2}", { when: { path: "countdown.past", eq: false } }),
    text("live", 2, "LIVE", { when: { path: "countdown.past", eq: true } }),
    text("line", 3, "{match.venue}, in {countdown.h}h {countdown.m}m"),
    text("hidden", 4, "never", { when: [{ path: "match.venue", eq: "elsewhere" }, { path: "countdown.past", eq: false }] }),
  ],
} as FlatTree;

const DATA = { match: { start_time: KICKOFF, venue: "Utilita Bowl" } };

const page = (now: number, render: typeof renderToString = renderToStaticMarkup) =>
  render(createElement(Render, { tree: TREE, data: DATA, now }));

describe("a clock, drawn by the server", () => {
  it("draws the digits as they read at the time of the render", () => {
    const html = page(NOW);
    expect(html).toMatch(/data-fos-id="days"[^>]*>02</);
    expect(html).toMatch(/data-fos-id="secs"[^>]*>33</);
    expect(html).toContain("Utilita Bowl, in 2h 12m");
    expect(html).not.toContain("LIVE");
  });

  it("decides a when that does not read the clock on the server, and leaves out what fails it", () => {
    expect(page(NOW)).not.toContain("never");
  });

  it("draws what the tree says for after the instant", () => {
    const html = page(Date.parse("2026-11-17T14:31:00Z"));
    expect(html).toContain("LIVE");
    expect(html).not.toContain('data-fos-id="days"');
    expect(html).toContain("Utilita Bowl, in 0h 1m");
  });

  it("puts nothing in scope when the data has no instant: what reads it is unbound", () => {
    const html = renderToStaticMarkup(createElement(Render, { tree: TREE, data: { match: {} }, now: NOW }));
    expect(html).not.toContain('data-fos-id="days"');
    expect(html).toContain("{countdown.h}h {countdown.m}m");
  });
});

describe("the client entry", () => {
  it("bundles for a browser with no Node built-ins", async () => {
    const bundle = await build({
      entryPoints: ["./src/client.tsx"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      external: ["react", "react-dom", "swiper", "swiper/*"],
      logLevel: "silent",
    });
    expect(bundle.errors).toEqual([]);
    expect(bundle.outputFiles[0]!.text).not.toContain("readFileSync");
  });
});

describe("a clock, in the browser", () => {
  let browser: Browser | undefined;
  afterAll(async () => browser?.close());

  it("ticks, and switches at the instant", async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { hydrateRoot } from "react-dom/client";
          import { Render } from "./src/components/Render.tsx";
          window.fosHydrate = (props) => hydrateRoot(document.getElementById("root"), createElement(Render, props));`,
        // The test hydrates the whole tree; a host hydrates only the client parts. What those
        // parts need must stay out of the theme loader: checked below on the client entry alone.
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      alias: { "@fanos/renderer/client": "./src/client.tsx" },
      // The whole renderer is hydrated here, tokens loader and all; a host hydrates only the
      // client parts. Its file reads never run in the page.
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
    // 9 seconds before kick-off
    const start = Date.parse("2026-11-17T14:29:51Z");
    await tab.clock.install({ time: start - 1_000 });
    await tab.clock.pauseAt(start);
    await tab.setContent(`<div id="root">${page(start, renderToString)}</div>`);
    await tab.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const errors: string[] = [];
    tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await tab.evaluate(
      ({ tree, data, now }) => (window as unknown as { fosHydrate: (p: unknown) => void }).fosHydrate({ tree, data, now }),
      { tree: TREE, data: DATA, now: start },
    );
    const read = (id: string) => tab.locator(`[data-fos-id="${id}"]`).textContent();

    expect(await read("secs")).toBe("09");
    await tab.clock.runFor(3_000);
    expect(await read("secs")).toBe("06");
    expect(await tab.locator('[data-fos-id="live"]').count()).toBe(0);

    await tab.clock.runFor(10_000);
    expect(await tab.locator('[data-fos-id="live"]').count()).toBe(1);
    expect(await tab.locator('[data-fos-id="days"]').count()).toBe(0);
    // counting up from the instant now
    await tab.clock.runFor(60_000);
    expect(await read("line")).toBe("Utilita Bowl, in 0h 1m");
    expect(errors).toEqual([]);
  });
});
