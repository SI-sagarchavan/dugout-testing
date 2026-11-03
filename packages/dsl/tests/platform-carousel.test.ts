import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromPlatformCarousel, type PlatformCarousel, toPlatformCarousel } from "../src/platform-carousel.js";
import { validate } from "../src/validate.js";
import { registry, tinyTree } from "./helpers.js";

const config = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/platform/carousel.json"), "utf8"),
) as PlatformCarousel;

// The theme's colour names the config uses, as Southern Brave's export has them.
const colors = new Set([
  "button_outline_style_3_text_default",
  "text_invert_high",
  "core_neu_50",
  "text_main_prim",
  "core_neu_700",
  "core_neu_200",
]);

describe("fromPlatformCarousel", () => {
  it("reads the Carousel's behaviour and motion into its props, and nothing about how controls look", () => {
    const { props } = fromPlatformCarousel(config, { colors });
    expect(props).toEqual({
      slidesPerView: 1,
      centered: false,
      direction: "horizontal",
      loop: false,
      freeMode: false,
      autoplay: { delay: { raw: 3000, _unbound: true } },
    });
  });

  it("reads each control as where it sits and how it looks in each state, in tokens", () => {
    const { arrows, indicator, progress, warnings } = fromPlatformCarousel(config, { colors });
    expect(arrows).toEqual({
      visible: true,
      position: "center",
      subVariant: "nearby",
      enabled: { tone: "color.button_outline_style_3_text_default" },
      icon: "icon_sb_left-small",
      variant: "1",
    });
    expect(indicator).toEqual({
      visible: true,
      kind: "counter",
      position: "bottom",
      offset: -20,
      stack: "horizontal",
      shape: "rounded",
      activeWidth: 30,
      active: { tone: "color.text_invert_high" },
      inactive: { tone: "color.core_neu_50" },
      variant: "1",
    });
    expect(progress).toEqual({ visible: true, type: "linear", look: { fill: "color.text_main_prim" } });
    // The theme has no `nue_700`: said, not guessed.
    expect(warnings).toEqual([
      'nav_arrows.disabled_color.text_color: "color_nue_700" is not a colour in this theme, so it was left out',
      'nav_arrows.disabled_color.background_color: "color_nue_200" is not a colour in this theme, so it was left out',
    ]);
  });

  it("paints dots with fill and a counter with tone", () => {
    const { indicator } = fromPlatformCarousel(
      { nav_indicator: { type: "bullets", visibility: true, enabled_color: "text_invert_high", disabled_color: "core_neu_50" } },
      { colors },
    );
    expect(indicator).toMatchObject({ kind: "pagination", active: { fill: "color.text_invert_high" }, inactive: { fill: "color.core_neu_50" } });
  });

  it("drops a color_ prefix the theme does not use", () => {
    const { indicator } = fromPlatformCarousel(
      { nav_indicator: { enabled_color: "color_core_neu_700", visibility: true } },
      { colors },
    );
    expect(indicator?.active).toEqual({ fill: "color.core_neu_700" });
  });

  it("says what it cannot map", () => {
    const { warnings } = fromPlatformCarousel({
      nav_arrows: { position: "middle" },
      nav_indicator: { type: "dashes", visibility: true },
      autoplay_progress: { type: "linear", visibility: true },
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("autoplay is off");
  });

  it("makes Carousel props the validator takes", () => {
    const { props } = fromPlatformCarousel(config, { colors });
    const tree = tinyTree([
      { id: "c", parent: null, idx: 0, type: "Carousel", src: "1:1", props },
      { id: "s", parent: "c", idx: 0, type: "Box", src: "1:2", props: {} },
    ] as never);
    expect(validate(tree, { registry: registry() }).errors).toEqual([]);
  });

  it("makes state looks the validator takes on a control node", () => {
    const { arrows, indicator } = fromPlatformCarousel(config, { colors });
    const tree = tinyTree([
      { id: "o", parent: null, idx: 0, type: "Stack", src: "1:0", props: {} },
      { id: "c", parent: "o", idx: 0, type: "Carousel", src: "1:1", props: { slidesPerView: 1, autoplay: false } },
      { id: "s", parent: "c", idx: 0, type: "Box", src: "1:2", props: {} },
      {
        id: "count",
        parent: "o",
        idx: 1,
        type: "Text",
        src: "1:3",
        props: { content: "1 / 3", style: "type.body_sm_regular", controlFor: { target: "c", part: "counter" }, states: { active: indicator?.active } },
      },
      { id: "prev", parent: "o", idx: 2, type: "Box", src: "1:4", props: { controlFor: { target: "c", part: "prev" }, states: { disabled: arrows?.enabled } } },
    ] as never);
    expect(validate(tree, { registry: registry() }).errors).toEqual([]);
  });
});

describe("toPlatformCarousel", () => {
  it("writes what it read back as the platform's config", () => {
    const back = toPlatformCarousel(fromPlatformCarousel(config, { colors }));
    expect(back).toEqual({
      ...config,
      variant: undefined,
      nav_arrows: {
        ...config.nav_arrows,
        // what the theme does not have was never read, so it is not written
        disabled_color: { text_color: "", background_color: "" },
      },
    });
  });
});
