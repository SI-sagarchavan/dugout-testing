/**
 * Input and Checkbox: real form controls in the design's look, each writing the page under its
 * key. Checked as markup, then in Chromium hydrated: typing and ticking change what another
 * section's `when` shows.
 */

import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { pageDefaults, type FlatTree } from "@fanos/dsl";
import { Render } from "../src/components/Render.js";

/** The newsletter's form: an email field, a consent box beside its text. */
const FORM: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "form", parent: null, idx: 0, type: "Stack", src: "1:1", props: { gap: "space.3" } },
    {
      id: "email",
      parent: "form",
      idx: 0,
      type: "Input",
      src: "1:2",
      props: {
        key: "email",
        kind: "email",
        placeholder: "Your Email Address",
        autocomplete: "email",
        style: "type.body_sm_regular",
        tone: "color.text_main_high",
        placeholderTone: "color.text_sec_disable",
        surface: "surface.button",
        size: { w: { raw: 509, _unbound: true }, h: { raw: 52, _unbound: true } },
      },
    },
    { id: "row", parent: "form", idx: 1, type: "Stack", src: "1:3", props: { direction: "row", gap: "space.3" } },
    {
      id: "consent",
      parent: "row",
      idx: 0,
      type: "Checkbox",
      src: "1:4",
      props: {
        key: "consent",
        label: "I'd like to hear from Southern Brave",
        mark: "color.text_invert_high",
        size: { w: { raw: 20, _unbound: true }, h: { raw: 20, _unbound: true } },
        states: { active: { surface: "surface.button" } },
      },
    },
    { id: "consent_text", parent: "row", idx: 1, type: "Text", src: "1:5", props: { content: "I'd like to hear from Southern Brave", style: "type.body_sm_regular" } },
  ],
} as FlatTree;

/** Another section that reads both. */
const NOTE: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "note", parent: null, idx: 0, type: "Stack", src: "2:1", props: {} },
    { id: "ticked", parent: "note", idx: 0, type: "Text", src: "2:2", props: { content: "Thanks", style: "type.body_sm_bold", when: { path: "_page.consent", eq: true } } },
    { id: "typed", parent: "note", idx: 1, type: "Text", src: "2:3", props: { content: "Sending to you", style: "type.body_sm_bold", when: { path: "_page.email", ne: "" } } },
  ],
} as FlatTree;

describe("fields, drawn by the server", () => {
  const html = renderToStaticMarkup(createElement(Render, { tree: FORM }));

  it("draws a real input with its name, kind, placeholder and autofill hint", () => {
    expect(html).toMatch(/<input[^>]*class="[^"]*fos-input[^"]*fos-type-body_sm_regular[^"]*"/);
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"/);
    expect(html).toContain('placeholder="Your Email Address"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('aria-label="Your Email Address"');
    expect(html).toContain("--fos-placeholder:var(--fos-color-text-sec-disable)");
    expect(html).toContain("width:var(--w-base)");
    expect(html).not.toContain("[object Object]");
  });

  it("draws a real checkbox over the box, unticked and inactive", () => {
    expect(html).toMatch(/data-fos-type="Checkbox"[^>]*data-fos-state="inactive"/);
    expect(html).toMatch(/<input class="fos-checkbox-input" type="checkbox"[^>]*name="consent"/);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain("fos-checkbox-mark");
  });

  it("starts ticked and active where the tree or the host says", () => {
    const ticked = structuredClone(FORM);
    (ticked.nodes[3]!.props as Record<string, unknown>).checked = true;
    expect(renderToStaticMarkup(createElement(Render, { tree: ticked }))).toMatch(/data-fos-state="active"/);
    const host = renderToStaticMarkup(createElement(Render, { tree: FORM, page: { consent: "true", email: "a@b.co" } }));
    expect(host).toMatch(/data-fos-state="active"/);
    expect(host).toContain('value="a@b.co"');
  });
});

describe("fields, in the browser", () => {
  let browser: Browser | undefined;
  afterAll(async () => browser?.close());

  it("typing and ticking write the page, and another section follows", async () => {
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
    const start = pageDefaults([FORM, NOTE]);
    await tab.setContent(
      `<div id="form">${renderToString(createElement(Render, { tree: FORM, page: start }))}</div>` +
        `<div id="note">${renderToString(createElement(Render, { tree: NOTE, page: start }))}</div>`,
    );
    await tab.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await tab.evaluate(
      ({ form, note, start }) => {
        const w = window as unknown as { fosHydrate: (id: string, p: unknown) => void };
        w.fosHydrate("form", { tree: form, page: start });
        w.fosHydrate("note", { tree: note, page: start });
      },
      { form: FORM, note: NOTE, start },
    );
    const shown = (id: string) => tab.locator(`[data-fos-id="${id}"]`).count();

    expect(await shown("ticked")).toBe(0);
    expect(await shown("typed")).toBe(0);

    await tab.locator('[data-fos-id="email"]').fill("fan@example.com");
    expect(await tab.locator('[data-fos-id="email"]').inputValue()).toBe("fan@example.com");
    expect(await shown("typed")).toBe(1);

    // a click on the drawn box ticks it: the input over it takes the click
    await tab.locator('[data-fos-id="consent"]').click();
    expect(await tab.locator('input[name="consent"]').isChecked()).toBe(true);
    expect(await tab.locator('[data-fos-id="consent"]').getAttribute("data-fos-state")).toBe("active");
    expect(await tab.locator('[data-fos-id="consent"] .fos-checkbox-mark').isVisible()).toBe(true);
    expect(await shown("ticked")).toBe(1);

    // Space unticks it from the keyboard
    await tab.locator('input[name="consent"]').focus();
    await tab.keyboard.press("Space");
    expect(await tab.locator('[data-fos-id="consent"]').getAttribute("data-fos-state")).toBe("inactive");
    expect(await shown("ticked")).toBe(0);
    expect(errors).toEqual([]);
  });
});
