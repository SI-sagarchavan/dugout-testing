/**
 * Carousel — the server's first paint, and Swiper taking it over without a jump.
 *
 * The first half is pure: the spec a node becomes and the markup the server draws. The second
 * runs real Swiper in Chromium on that markup (`mountCarousel`, bundled as the browser gets it)
 * and measures: a screenshot sees only the first paint, so it must already be the design, and
 * a visitor must not see the slides move when the script arrives.
 *
 * The carousel draws no controls. Every arrow, dot, counter and bar is a node with `controlFor`,
 * and every look in a state is the node's `states`, in tokens: these tests check that the browser
 * sets the states and the tree's looks follow.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { FlatTree } from "@fanos/dsl";
import { emitCss, loadSurfaces, loadTheme } from "@fanos/tokens";
import { Render } from "../src/components/Render.js";
import { carouselSpec, cssNumber } from "../src/carousel/spec.js";

const ROOT = process.cwd();
const THEME = join(ROOT, "../tokens/fixtures/southern-brave.json");
const SURFACES = join(ROOT, "../tokens/surfaces/southern-brave.json");

const raw = (px: number) => ({ raw: px, _unbound: true });
const box = (id: string, parent: string, idx: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
  id,
  parent,
  idx,
  type: "Box",
  src: `1:${id}`,
  props: { size: { w: raw(w), h: raw(h) }, ...extra },
});

/** A 600px page: a carousel of five 200px slides, designed arrows, and a row of three dots. */
function strip(carousel: Record<string, unknown> = {}, slideW = 200): FlatTree {
  return {
    schemaVersion: "1",
    nodes: [
      { id: "page", parent: null, idx: 0, type: "Stack", src: "1:0", props: { size: { w: raw(600) } } },
      {
        id: "rail",
        parent: "page",
        idx: 0,
        type: "Carousel",
        src: "1:1",
        props: {
          slidesPerView: "auto",
          gap: "space.4",
          offsetBefore: raw(20),
          clip: true,
          speed: raw(0),
          loop: false,
          autoplay: false,
          size: { w: raw(600) },
          ...carousel,
        },
      },
      ...[0, 1, 2, 3, 4].map((i) => box(`slide${i}`, "rail", i, slideW, 100)),
      {
        id: "arrows",
        parent: "page",
        idx: 1,
        type: "Stack",
        src: "1:2",
        props: { direction: "row", gap: "space.2" },
      },
      box("back", "arrows", 0, 40, 40, { controlFor: { target: "rail", part: "prev" }, states: DISABLED }),
      box("fwd", "arrows", 1, 40, 40, { controlFor: { target: "rail", part: "next" }, states: DISABLED }),
      {
        id: "dots",
        parent: "page",
        idx: 2,
        type: "Stack",
        src: "1:3",
        props: { direction: "row", gap: "space.2", controlFor: { target: "rail", part: "pagination" } },
      },
      // The active dot is the pill: wider than the rest.
      box("dot0", "dots", 0, 16, 8),
      box("dot1", "dots", 1, 8, 8),
      box("dot2", "dots", 2, 8, 8),
    ],
  } as FlatTree;
}

/** The strip without the designed arrows and dots, plus `extra` nodes. */
function bare(carousel: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): FlatTree {
  const tree = strip(carousel);
  const designed = new Set(["arrows", "back", "fwd", "dots", "dot0", "dot1", "dot2"]);
  const nodes = [...tree.nodes.filter((n) => !designed.has(n.id)), ...extra] as FlatTree["nodes"];
  // The page's children in the order given, numbered from 0.
  let idx = 0;
  return { ...tree, nodes: nodes.map((n) => (n.parent === "page" ? { ...n, idx: idx++ } : n)) } as FlatTree;
}

/** An arrow with nowhere to go, as the platform config's disabled colours make it. */
const DISABLED = { disabled: { fill: "color.core_neu_200", tone: "color.core_neu_700" } };

const counter = (format?: string) => ({
  id: "count",
  parent: "page",
  idx: 3,
  type: "Text",
  src: "1:9",
  props: {
    content: "1 / 4",
    style: "type.body_sm_regular",
    controlFor: { target: "rail", part: "counter", ...(format ? { format } : {}) },
  },
});
const bar = (of?: "slides") => box("bar", "page", 4, 600, 4, {
  fill: "color.text_main_prim",
  controlFor: { target: "rail", part: "progress", ...(of ? { of } : {}) },
});

/** A theme colour var, as the browser computes a colour (rgb(…)). */
const cssColor = (page: Page, name: string) =>
  page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${v})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

const markup = (tree: FlatTree) => renderToStaticMarkup(createElement(Render, { tree, width: 600 }));

describe("the spec a Carousel node becomes", () => {
  it("keeps token values as vars, for the first paint and for Swiper to read computed", () => {
    const { spec, vars } = carouselSpec("rail", {
      slidesPerView: "auto",
      gap: "space.4",
      offsetBefore: raw(20),
      speed: raw(450),
      autoplay: { delay: raw(5000), pauseOnHover: false },
      easing: "easing.spring",
    });
    expect(vars).toEqual({
      "--fos-carousel-gap": "var(--fos-space-4)",
      "--fos-carousel-before": "20px",
      "--fos-carousel-speed": "450ms",
      "--fos-carousel-delay": "5000ms",
      "--swiper-wrapper-transition-timing-function": "var(--fos-easing-spring)",
    });
    expect(spec).toMatchObject({
      id: "rail",
      slidesPerView: "auto",
      autoplay: { pauseOnHover: false, stopOnInteraction: false },
      effect: { kind: "slide", options: {} },
      keyboard: true,
      draggable: true,
    });
  });

  it("takes an effect by name or with its options", () => {
    expect(carouselSpec("c", { effect: "fade" }).spec.effect).toEqual({ kind: "fade", options: {} });
    const next = { translate: ["100%", 0, 0], scale: 0.9 };
    expect(carouselSpec("c", { effect: { kind: "creative", next, prev: { translate: [0, 0, -400] } } }).spec.effect).toEqual({
      kind: "creative",
      options: { next, prev: { translate: [0, 0, -400] } },
    });
    expect(carouselSpec("c", { effect: "wobble" }).spec.effect.kind).toBe("slide");
  });

  it("records where a centred carousel centres only when it is centred", () => {
    expect(carouselSpec("c", { centered: true, centerAt: 466 }).vars["--fos-carousel-center"]).toBe("466px");
    expect(carouselSpec("c", { centerAt: 466 }).vars["--fos-carousel-center"]).toBeUndefined();
  });

  it("reads computed px and ms", () => {
    expect(cssNumber(" 16px", 0)).toBe(16);
    expect(cssNumber("0.3s", 0)).toBe(300);
    expect(cssNumber("450ms", 0)).toBe(450);
    expect(cssNumber("", 7)).toBe(7);
  });
});

describe("the server's markup", () => {
  const html = markup(strip());

  it("wraps each child in a slide inside Swiper's own structure", () => {
    expect(html).toMatch(/class="[^"]*fos-carousel[^"]*"[^>]*data-fos-carousel="/);
    expect(html.match(/class="swiper-slide"/g)).toHaveLength(5);
    expect(html).toContain('<div class="swiper fos-carousel-viewport"><div class="swiper-wrapper">');
  });

  it("marks the designed arrows as buttons for this carousel, and draws no arrows of its own", () => {
    expect(html).toMatch(/data-fos-control-for="rail" data-fos-control="next" role="button" tabindex="0" aria-label="Next"/);
    expect(html).toMatch(/data-fos-control-for="rail" data-fos-control="prev"/);
    expect(html).not.toContain("data-fos-chrome");
  });

  it("draws nothing but the slides: no arrows, dots or bars of its own", () => {
    const own = markup(bare({ autoplay: { delay: raw(2000) } }));
    expect(own).not.toContain("data-fos-chrome");
    expect(own).not.toMatch(/fos-carousel-(arrow|pagination|autoplay|scrollbar)/);
  });

  it("writes each control's format and what it counts, and a rule for each state the tree gives", () => {
    const html = markup(bare({}, [counter("{index} of {count}"), bar("slides")]));
    expect(html).toContain('data-fos-control="counter" data-fos-format="{index} of {count}"');
    expect(html).toContain('data-fos-control="progress" data-fos-of="slides"');
    const arrows = markup(strip());
    expect(arrows).toContain('[data-fos-id="back"][data-fos-state~="disabled"] { background: var(--fos-color-core-neu-200) !important; }');
  });

  it("makes each repetition of a Repeater one slide", () => {
    const tree = {
      schemaVersion: "1",
      nodes: [
        { id: "rail", parent: null, idx: 0, type: "Carousel", src: "1:1", props: { slidesPerView: 2, autoplay: false } },
        { id: "rep", parent: "rail", idx: 0, type: "Repeater", src: "1:2", props: { over: "news", as: "story" } },
        { id: "title", parent: "rep", idx: 0, type: "Text", src: "1:3", props: { content: "{story.title}", style: "type.body_sm_regular" } },
      ],
    } as FlatTree;
    const out = renderToStaticMarkup(
      createElement(Render, { tree, data: { news: [{ title: "One" }, { title: "Two" }, { title: "Three" }] } }),
    );
    expect(out.match(/class="swiper-slide"/g)).toHaveLength(3);
    expect(out).toContain("Three");
  });
});

// ---------------------------------------------------------------------------
// In Chromium, with real Swiper
// ---------------------------------------------------------------------------

let browser: Browser | undefined;
afterAll(async () => {
  await browser?.close();
});

const themeCss = () => emitCss(loadTheme(THEME), { surfaces: loadSurfaces(SURFACES) }).css;
const styles = readFileSync(join(ROOT, "src/styles.css"), "utf8");

/** `mountCarousel` as the browser gets it, with Swiper bundled in, on `window.fosMount`. */
const bundle = (async () => {
  const result = await build({
    stdin: {
      contents: `import { mountCarousel } from "./src/carousel/mount.ts"; window.fosMount = () => [...document.querySelectorAll("[data-fos-carousel]")].map(mountCarousel);`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  return result.outputFiles[0]!.text;
})();

async function open(tree: FlatTree): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  await page.setContent(
    `<!DOCTYPE html><html><head><style>${themeCss()}${styles} html,body{margin:0}</style></head><body>${markup(tree)}</body></html>`,
  );
  await page.addScriptTag({ content: await bundle });
  return page;
}

/** Each slide's left edge, relative to the carousel's. */
const lefts = (page: Page) =>
  page.evaluate(() => {
    const rail = document.querySelector('[data-fos-type="Carousel"]')!.getBoundingClientRect();
    return [...document.querySelectorAll(".swiper-slide")].map((s) => Math.round((s.getBoundingClientRect().left - rail.left) * 10) / 10);
  });
const mount = (page: Page) => page.evaluate(() => (window as unknown as { fosMount: () => void }).fosMount());
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

describe("in a browser", () => {
  it("draws the design before any script: the offset, then slides a gap apart", async () => {
    const page = await open(strip());
    // 20px in; each 200px slide 16px (space.4) after the last.
    expect(await lefts(page)).toEqual([20, 236, 452, 668, 884]);
    await page.close();
  });

  it("does not move a slide when Swiper takes over", async () => {
    const page = await open(strip());
    const before = await lefts(page);
    await mount(page);
    await settle(page);
    expect(await page.getAttribute('[data-fos-type="Carousel"]', "data-fos-swiper")).toBe("on");
    expect(await lefts(page)).toEqual(before);
    await page.close();
  });

  it("moves on the designed next arrow, and the previous one leaves its disabled look", async () => {
    const page = await open(strip());
    await mount(page);
    await settle(page);
    const prev = () =>
      page.$eval('[data-fos-control="prev"]', (el) => ({
        state: el.getAttribute("data-fos-state"),
        aria: el.getAttribute("aria-disabled"),
        bg: getComputedStyle(el).backgroundColor,
      }));
    expect(await prev()).toEqual({ state: "disabled", aria: "true", bg: await cssColor(page, "--fos-color-core-neu-200") });
    await page.click('[data-fos-control="next"]');
    await settle(page);
    expect((await lefts(page))[1]).toBe(20);
    const after = await prev();
    expect(after.state).toBeNull();
    expect(after.aria).toBe("false");
    expect(after.bg).not.toBe(await cssColor(page, "--fos-color-core-neu-200"));
    await page.close();
  });

  it("moves the designed active dot's look to the page on show, and goes to a page from its dot", async () => {
    const page = await open(strip());
    await mount(page);
    const widths = () => page.$$eval('[data-fos-control="pagination"] > *', (dots) => dots.map((d) => d.getBoundingClientRect().width));
    expect(await widths()).toEqual([16, 8, 8]);
    await page.click('[data-fos-control="next"]');
    await settle(page);
    expect(await widths()).toEqual([8, 16, 8]);
    // The last dot is the last page: the end of the rail.
    await page.click('[data-fos-control="pagination"] > :nth-child(3)');
    await settle(page);
    expect(await widths()).toEqual([8, 8, 16]);
    expect(await page.getAttribute('[data-fos-control="next"]', "data-fos-state")).toBe("disabled");
    await page.close();
  });

  it("repeats one dot with states per page, the current one in its active look", async () => {
    const dots = [
      { id: "dots", parent: "page", idx: 2, type: "Stack", src: "1:3", props: { direction: "row", gap: "space.2", controlFor: { target: "rail", part: "pagination" } } },
      box("dot", "dots", 0, 8, 8, {
        fill: "color.core_neu_200",
        states: { active: { fill: "color.text_main_prim", transform: { scale: 1.5 } } },
        transition: { duration: "duration.instant" },
      }),
    ];
    const page = await open(bare({}, dots));
    await mount(page);
    await settle(page);
    const look = () =>
      page.$$eval('[data-fos-control="pagination"] > *', (els) =>
        els.map((d) => ({ state: d.getAttribute("data-fos-state"), bg: getComputedStyle(d).backgroundColor })),
      );
    const on = await cssColor(page, "--fos-color-text-main-prim");
    const off = await cssColor(page, "--fos-color-core-neu-200");
    // Five 200px slides in a 600px row: four stops, so four dots.
    expect(await look()).toEqual([
      { state: "active", bg: on },
      { state: "inactive", bg: off },
      { state: "inactive", bg: off },
      { state: "inactive", bg: off },
    ]);
    await page.click('[data-fos-control="pagination"] > :nth-child(3)');
    await settle(page);
    expect((await look()).map((d) => d.state)).toEqual(["inactive", "inactive", "active", "inactive"]);
    await page.close();
  });

  it("says which slide is on show, for the tree's active and inactive looks", async () => {
    const tree = bare({ slidesPerView: 1, centered: true }, [box("fwd", "page", 0, 40, 40, { controlFor: { target: "rail", part: "next" } })]);
    for (const n of tree.nodes) {
      if (n.parent === "rail") n.props = { ...n.props, states: { inactive: { opacity: "opacity.40", transform: { scale: 0.9 } } } };
    }
    const page = await open(tree);
    await mount(page);
    await settle(page);
    const opacities = () => page.$$eval(".swiper-slide > *", (els) => els.map((el) => getComputedStyle(el).opacity));
    expect(await opacities()).toEqual(["1", "0.4", "0.4", "0.4", "0.4"]);
    await page.click('[data-fos-control="next"]');
    await settle(page);
    expect(await opacities()).toEqual(["0.4", "1", "0.4", "0.4", "0.4"]);
    await page.close();
  });

  it("works arrows drawn on every slide", async () => {
    const tree = bare({ slidesPerView: 1 });
    for (let i = 0; i < 5; i++) {
      tree.nodes.push(box(`go${i}`, `slide${i}`, 0, 20, 20, { controlFor: { target: "rail", part: "next" }, states: DISABLED }) as never);
    }
    const page = await open(tree);
    await mount(page);
    await settle(page);
    await page.click('.swiper-slide-active [data-fos-control="next"]');
    await settle(page);
    expect(await page.$eval(".swiper-slide-active", (el) => el.firstElementChild?.getAttribute("data-fos-id"))).toBe("slide1");
    // Not at the end: none of the five is disabled.
    expect(await page.$$eval('[data-fos-control="next"]', (els) => els.map((e) => e.getAttribute("data-fos-state")))).toEqual(
      Array(5).fill(null),
    );
    await page.close();
  });

  it("writes the counter in its format", async () => {
    const page = await open(bare({}, [counter("{index} of {count}"), box("fwd", "page", 5, 40, 40, { controlFor: { target: "rail", part: "next" } })]));
    await mount(page);
    await settle(page);
    // Swiper counts the stops it can scroll to: five 200px slides in a 600px row have four.
    expect(await page.textContent('[data-fos-control="counter"]')).toBe("1 of 4");
    await page.click('[data-fos-control="next"]');
    await settle(page);
    expect(await page.textContent('[data-fos-control="counter"]')).toBe("2 of 4");
    await page.close();
  });

  it("fills a progress node as the slide's time runs out", async () => {
    const page = await open(bare({ autoplay: { delay: raw(2000) } }, [bar()]));
    await mount(page);
    await page.waitForTimeout(700);
    const scale = await page.$eval('[data-fos-control="progress"]', (el) => new DOMMatrix(getComputedStyle(el).transform).a);
    expect(scale).toBeGreaterThan(0.1);
    expect(scale).toBeLessThan(0.9);
    // Its look is the tree's: a 4px bar in the theme's colour.
    expect(await page.$eval('[data-fos-control="progress"]', (el) => getComputedStyle(el).backgroundColor)).toBe(
      await cssColor(page, "--fos-color-text-main-prim"),
    );
    await page.close();
  });

  it("fills a progress node of the slides to how far through they are", async () => {
    const page = await open(bare({}, [bar("slides"), box("fwd", "page", 5, 40, 40, { controlFor: { target: "rail", part: "next" } })]));
    await mount(page);
    await settle(page);
    const scale = () => page.$eval('[data-fos-control="progress"]', (el) => new DOMMatrix(getComputedStyle(el).transform).a);
    expect(await scale()).toBe(0);
    await page.click('[data-fos-control="next"]');
    await settle(page);
    expect(await scale()).toBeCloseTo(1 / 3);
    await page.close();
  });

  it("runs an effect with the options the tree gives", async () => {
    const effect = { kind: "creative", prev: { translate: ["-20%", 0, -1], opacity: 0.5 }, next: { translate: ["100%", 0, 0] } };
    const page = await open(bare({ slidesPerView: 1, effect }, [box("fwd", "page", 5, 40, 40, { controlFor: { target: "rail", part: "next" } })]));
    await mount(page);
    await settle(page);
    expect(await page.getAttribute('[data-fos-type="Carousel"] > .swiper', "class")).toContain("swiper-creative");
    await page.click('[data-fos-control="next"]');
    await settle(page);
    // The slide gone by is pushed back and faded, as `prev` says.
    expect(await page.$eval(".swiper-slide:first-child", (el) => getComputedStyle(el).opacity)).toBe("0.5");
    await page.close();
  });

  it("lets a drag through a row laid over the slides, where the row draws nothing", async () => {
    // The fixtures strip: its arrows sit in a row as wide as the strip, laid over the cards.
    const tree = {
      schemaVersion: "1",
      nodes: [
        { id: "page", parent: null, idx: 0, type: "Overlay", src: "1:0", props: { size: { w: raw(600), h: raw(140) } } },
        {
          id: "rail",
          parent: "page",
          idx: 0,
          type: "Carousel",
          src: "1:1",
          props: { slidesPerView: "auto", gap: "space.4", clip: true, speed: raw(0), loop: false, autoplay: false, place: { anchor: "top-fill" } },
        },
        ...[0, 1, 2, 3, 4].map((i) => box(`slide${i}`, "rail", i, 200, 100)),
        {
          id: "arrows",
          parent: "page",
          idx: 1,
          type: "Stack",
          src: "1:2",
          props: { direction: "row", gap: "space.2", place: { anchor: "top-fill", offset: { block: raw(30) } } },
        },
        box("back", "arrows", 0, 40, 40, { controlFor: { target: "rail", part: "prev" } }),
        box("fwd", "arrows", 1, 40, 40, { controlFor: { target: "rail", part: "next" } }),
        // An edge fade over the end of the slides: paint and nothing else.
        box("fade", "page", 2, 160, 100, { surface: "surface.button_prim", place: { anchor: "top-end" } }),
      ],
    } as FlatTree;
    const page = await open(tree);
    await mount(page);
    await settle(page);
    const under = (x: number, y: number) =>
      page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest(".swiper-slide") ? "slide" : (el?.closest("[data-fos-id]")?.getAttribute("data-fos-id") ?? null);
      }, [x, y] as const);
    // In the row's band, past the arrows: the slide. On an arrow: the arrow.
    expect(await under(400, 50)).toBe("slide");
    expect(await under(20, 50)).toBe("back");
    // Under the fade, the slide too: decoration takes no pointer.
    expect(await under(560, 50)).toBe("slide");

    const before = await lefts(page);
    await page.mouse.move(400, 50);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(400 - i * 30, 50);
    await page.mouse.up();
    await settle(page);
    expect(await lefts(page)).not.toEqual(before);
    await page.close();
  });

  it("centres the active slide in the first paint and keeps it there", async () => {
    // Slide 1 of 300px slides, 16px apart: its centre is 316 + 150 = 466 from the first's start.
    const tree = strip({ centered: true, initialSlide: 1, centerAt: 466, offsetBefore: undefined }, 300);
    const page = await open(tree);
    const centre = async () => (await lefts(page))[1]! + 150;
    expect(await centre()).toBe(300);
    await mount(page);
    await settle(page);
    expect(await centre()).toBe(300);
    await page.close();
  });

  it("leaves no empty space before the first slide when centred within bounds", async () => {
    const tree = strip({ centered: true, centeredBounds: true, initialSlide: 1, centerAt: 466, offsetBefore: undefined }, 300);
    const page = await open(tree);
    await mount(page);
    await settle(page);
    // Mid-strip, still centred where the design centres it.
    expect((await lefts(page))[1]! + 150).toBe(300);
    await page.click('[data-fos-control="prev"]');
    await settle(page);
    // At the start, the first slide is at the carousel's edge, not in its middle.
    expect((await lefts(page))[0]).toBe(0);
    await page.close();
  });

  it("lets a bleeding carousel's slides show past its own box", async () => {
    const page = await open(strip({ clip: false, size: { w: raw(400) } }));
    const overflow = await page.$eval('[data-fos-type="Carousel"] > .swiper', (el) => getComputedStyle(el).overflow);
    expect(overflow).toBe("visible");
    await page.close();
  });
});
