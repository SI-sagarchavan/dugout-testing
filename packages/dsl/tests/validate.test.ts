/**
 * Every rule, plus the acceptance mutations: change one thing on the real card
 * and assert the RIGHT error comes back — not merely that something failed.
 */

import { describe, expect, it } from "vitest";
import { issuesByCode, validate } from "../src/validate.js";
import { card, nodeOf, registry, tinyTree } from "./helpers.js";

function check(tree: ReturnType<typeof card>) {
  return validate(tree, { registry: registry() });
}

describe("the card fixture", () => {
  it("validates with zero errors", () => {
    const result = check(card());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("S1 — the tree must fold up", () => {
  it("reports a reify failure once, with the offending node", () => {
    const tree = card();
    nodeOf(tree, "role").parent = "ghost";
    const [issue] = issuesByCode(check(tree), "S1");
    expect(issue?.message).toContain("ghost");
  });
});

describe("S2 — unknown node type", () => {
  it("names the type", () => {
    const tree = card();
    nodeOf(tree, "role").type = "Marquee";
    const [issue] = issuesByCode(check(tree), "S2");
    expect(issue?.message).toContain("Marquee");
  });
});

describe("S3 — identity", () => {
  it("rejects a duplicate id", () => {
    const tree = card();
    nodeOf(tree, "role").id = "cutout";
    expect(issuesByCode(check(tree), "S3").some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  it("rejects a missing src — every node needs a Figma origin for the repair loop", () => {
    const tree = card();
    nodeOf(tree, "role").src = "";
    expect(issuesByCode(check(tree), "S3").some((i) => i.message.includes("missing src"))).toBe(true);
  });
});

describe("S4 — Section placement", () => {
  it("rejects a Section that is not a direct child of the root", () => {
    const tree = tinyTree([
      { id: "root", parent: null, idx: 0, type: "Box", src: "1:1", props: {} },
      { id: "mid", parent: "root", idx: 0, type: "Box", src: "1:2", props: {} },
      { id: "sec", parent: "mid", idx: 0, type: "Section", src: "1:3", props: { width: "content" } },
    ]);
    expect(issuesByCode(check(tree), "S4")).toHaveLength(1);
  });

  it("accepts one directly under the root", () => {
    const tree = tinyTree([
      { id: "root", parent: null, idx: 0, type: "Box", src: "1:1", props: {} },
      { id: "sec", parent: "root", idx: 0, type: "Section", src: "1:2", props: { width: "content" } },
    ]);
    expect(issuesByCode(check(tree), "S4")).toEqual([]);
  });
});

describe("S5 — Repeater is a fragment", () => {
  const repeaterWith = (props: Record<string, unknown>) =>
    tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      { id: "rep", parent: "root", idx: 0, type: "Repeater", src: "1:2", props: { over: "players", as: "player", ...props } },
    ]);

  it("rejects a layout prop", () => {
    const [issue] = issuesByCode(check(repeaterWith({ gap: "space.4" })), "S5");
    expect(issue?.path).toBe("gap");
    expect(issue?.message).toContain("fragment");
  });

  it("rejects space, size, surface and place", () => {
    for (const [prop, value] of [
      ["space", { p: "space.4" }],
      ["size", { w: "full" }],
      ["surface", "surface.card_player"],
      ["place", { anchor: "center" }],
    ] as const) {
      expect(issuesByCode(check(repeaterWith({ [prop]: value })), "S5"), prop).toHaveLength(1);
    }
  });

  it("accepts a bare Repeater", () => {
    expect(check(repeaterWith({})).errors).toEqual([]);
  });
});

describe("S6 / S7 — place belongs to the child, checked against the parent", () => {
  /**
   * A Stack positions the children that opt OUT of its flow. Figma does this —
   * an absolutely-positioned child of an auto-layout frame — and CSS renders it
   * as `position: absolute` inside a `position: relative` box. Forbidding it
   * forced the compiler to demote the whole frame to an Overlay, which anchors
   * every sibling and discards the row.
   */
  it("accepts place.anchor under a Stack — a child may opt out of the flow", () => {
    const tree = card();
    // `stat_matches_label` sits under `stat_matches`, a Stack.
    nodeOf(tree, "stat_matches_label").props["place"] = { anchor: "center" };
    expect(issuesByCode(check(tree), "S6")).toHaveLength(0);
  });

  it("still rejects place.anchor under a parent that cannot position it", () => {
    const tree = tinyTree([
      { id: "b", parent: null, idx: 0, type: "Box", src: "1:1", props: {} },
      { id: "c", parent: "b", idx: 0, type: "Box", src: "1:2", props: { place: { anchor: "center" } } },
    ]);
    const [issue] = issuesByCode(check(tree), "S6");
    expect(issue?.nodeId).toBe("c");
    expect(issue?.message).toContain("Box");
  });

  it("rejects place.span when the parent is not a Grid", () => {
    const tree = card();
    nodeOf(tree, "stat_matches_label").props["place"] = { span: 2 };
    expect(issuesByCode(check(tree), "S7")).toHaveLength(1);
  });

  it("accepts place.span under a Grid", () => {
    const tree = tinyTree([
      { id: "g", parent: null, idx: 0, type: "Grid", src: "1:1", props: { columns: 3 } },
      { id: "c", parent: "g", idx: 0, type: "Box", src: "1:2", props: { place: { span: 2 } } },
    ]);
    expect(check(tree).errors).toEqual([]);
  });
});

describe("S8 — Overlay children must declare where they go", () => {
  it("rejects a child with no anchor", () => {
    const tree = card();
    delete nodeOf(tree, "cutout").props["place"];
    const [issue] = issuesByCode(check(tree), "S8");
    expect(issue?.nodeId).toBe("cutout");
  });

  it("does NOT flag duplicate anchors between siblings — that is how layering works", () => {
    // The IR card has two top-center children: the cutout and the name.
    const tree = card();
    const anchors = tree.nodes
      .filter((n) => n.parent === "card")
      .map((n) => (n.props["place"] as { anchor?: string } | undefined)?.anchor);
    // card_bg, cutout and name all anchor top-center.
    expect(anchors.filter((a) => a === "top-center")).toHaveLength(3);
    expect(check(tree).errors).toEqual([]);
  });
});

describe("S9 — Grid auto columns", () => {
  const grid = (props: Record<string, unknown>) =>
    tinyTree([{ id: "g", parent: null, idx: 0, type: "Grid", src: "1:1", props }]);

  it("rejects columns:\"auto\" with no minItemWidth", () => {
    expect(issuesByCode(check(grid({ columns: "auto" })), "S9")).toHaveLength(1);
  });

  it("accepts it once minItemWidth is present", () => {
    expect(issuesByCode(check(grid({ columns: "auto", minItemWidth: "space.16" })), "S9")).toEqual([]);
  });

  it("catches \"auto\" hiding inside a responsive wrapper", () => {
    expect(issuesByCode(check(grid({ columns: { base: 2, lg: "auto" } })), "S9")).toHaveLength(1);
  });
});

describe("S10 — Carousel chrome (warning, heuristic)", () => {
  it("warns rather than errors, because it is a guess", () => {
    const tree = tinyTree([
      {
        id: "c",
        parent: null,
        idx: 0,
        type: "Carousel",
        src: "1:1",
        props: {
          slidesPerView: 3,
          loop: false,
          autoplay: false,
        },
      },
      { id: "arrow", parent: "c", idx: 0, type: "Icon", src: "1:2-arrow-right", props: { name: "chevron" } },
    ]);
    const result = check(tree);
    expect(result.errors).toEqual([]);
    expect(issuesByCode(result, "S10")).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});

describe("S15 — Carousel options Swiper cannot combine", () => {
  const carousel = (props: Record<string, unknown>) =>
    tinyTree([
      {
        id: "c",
        parent: null,
        idx: 0,
        type: "Carousel",
        src: "1:1",
        props: { slidesPerView: 1, autoplay: false, ...props },
      },
      { id: "s", parent: "c", idx: 0, type: "Box", src: "1:2", props: {} },
    ]);

  it("accepts the full Swiper option set when nothing conflicts", () => {
    const result = check(
      carousel({
        slidesPerView: { base: 1.2, md: 2, lg: 3 },
        slidesPerGroup: { base: 1, lg: 3 },
        gap: "space.md",
        centered: true,
        effect: "coverflow",
        speed: { raw: 450, _unbound: true },
        loop: true,
        autoplay: { delay: { raw: 5000, _unbound: true }, pauseOnHover: true, stopOnInteraction: false },
        freeMode: { momentum: true, sticky: true },
        easing: "easing.spring",
        keyboard: true,
        grabCursor: true,
      }),
    );
    expect(issuesByCode(result, "S15")).toEqual([]);
    expect(issuesByCode(result, "S12")).toEqual([]);
  });

  it("rejects loop with rewind", () => {
    const [issue] = issuesByCode(check(carousel({ loop: true, rewind: true })), "S15");
    expect(issue?.severity).toBe("error");
    expect(issue?.path).toBe("rewind");
  });

  it("rejects rows with loop, at any width", () => {
    const [issue] = issuesByCode(check(carousel({ loop: true, rows: { base: 1, lg: 2 } })), "S15");
    expect(issue?.path).toBe("rows");
  });

  it("rejects a vertical carousel without a fixed height", () => {
    expect(issuesByCode(check(carousel({ direction: "vertical" })), "S15")).toHaveLength(1);
    expect(issuesByCode(check(carousel({ direction: "vertical", size: { h: "full" } })), "S15")).toHaveLength(1);
    expect(issuesByCode(check(carousel({ direction: "vertical", size: { h: { raw: 480, _unbound: true } } })), "S15")).toEqual([]);
  });

  it("warns when a one-at-a-time effect is given several slides per view", () => {
    const [issue] = issuesByCode(check(carousel({ effect: "fade", slidesPerView: { base: 1, lg: 3 } })), "S15");
    expect(issue?.severity).toBe("warning");
  });

  it("warns when an autoplaying carousel cannot be paused: no hover pause and no control", () => {
    const tree = carousel({ autoplay: { delay: { raw: 4000, _unbound: true }, pauseOnHover: false } });
    const [issue] = issuesByCode(check(tree), "S15");
    expect(issue?.path).toBe("autoplay.pauseOnHover");
    expect(issue?.severity).toBe("warning");
    // An arrow is a way to stop it.
    const withArrow = tinyTree([
      ...tree.nodes,
      { id: "n", parent: null, idx: 1, type: "Box", src: "1:3", props: { controlFor: { target: "c", part: "next" } } },
    ] as never);
    expect(issuesByCode(check(withArrow), "S15")).toEqual([]);
  });

  it("takes every Swiper effect with its options, a stack of cards among them", () => {
    const stacked = {
      kind: "creative",
      prev: { translate: ["-45%", 0, -120], scale: 0.82 },
      next: { translate: ["45%", 0, -120], scale: 0.82 },
      limitProgress: 2,
    };
    for (const effect of [
      stacked,
      { kind: "coverflow", rotate: 0, depth: 160, stretch: 40, modifier: 1, shadows: false },
      { kind: "fade", crossFade: true },
      { kind: "cards", perSlideOffset: 12 },
    ]) {
      const result = check(carousel({ effect }));
      expect(issuesByCode(result, "S12"), JSON.stringify(effect)).toEqual([]);
    }
    expect(issuesByCode(check(carousel({ effect: { kind: "creative", prev: { scale: 0.8 } } })), "S12").length).toBeGreaterThan(0);
  });

  it("no longer takes renderer-drawn controls: a control is a node", () => {
    expect(issuesByCode(check(carousel({ controls: ["arrows"] })), "S12").length).toBeGreaterThan(0);
  });

  it("rejects options Swiper does not have", () => {
    expect(issuesByCode(check(carousel({ snap: "start" })), "S12").length).toBeGreaterThan(0);
    expect(issuesByCode(check(carousel({ effect: "parallax" })), "S12").length).toBeGreaterThan(0);
  });
});

describe("S11 — Custom.ref", () => {
  const custom = (ref: unknown) =>
    tinyTree([{ id: "x", parent: null, idx: 0, type: "Custom", src: "1:1", props: { ref, props: {} } }]);

  it("rejects a ref without a version", () => {
    expect(issuesByCode(check(custom("player-card")), "S11")).toHaveLength(1);
  });

  it("accepts name@semver", () => {
    expect(issuesByCode(check(custom("player-card@1.2.3")), "S11")).toEqual([]);
  });
});

describe("T1 — unresolvable token refs", () => {
  it("names the ref, the node, the path and up to three near misses", () => {
    const tree = card();
    nodeOf(tree, "card").props["surface"] = "surface.nope";
    const [issue] = issuesByCode(check(tree), "T1");
    expect(issue?.nodeId).toBe("card");
    expect(issue?.path).toBe("surface");
    expect(issue?.message).toContain("surface.nope");
    expect(issue?.suggestions).toContain("surface.card_player");
    expect(issue?.suggestions?.length).toBeLessThanOrEqual(3);
  });

  it("catches an out-of-range spacing step", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = "space.99";
    const [issue] = issuesByCode(check(tree), "T1");
    expect(issue?.message).toContain("space.99");
    expect(issue?.suggestions?.every((s) => s.startsWith("space."))).toBe(true);
  });

  it("accepts space.7, which this theme really does have", () => {
    // The scale runs 0-16 plus half-steps; nothing stops at 6.
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = "space.7";
    expect(issuesByCode(check(tree), "T1")).toEqual([]);
  });

  it("resolves a negated offset ref", () => {
    const tree = card();
    expect(check(tree).errors).toEqual([]);
    (nodeOf(tree, "badges").props["place"] as { offset: Record<string, string> }).offset["inline"] = "-space.99";
    expect(issuesByCode(check(tree), "T1")).toHaveLength(1);
  });
});

describe("T2 — Text.style must be a type token", () => {
  it("rejects a colour ref", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = "color.core_neu_00";
    const [issue] = issuesByCode(check(tree), "T2");
    expect(issue?.nodeId).toBe("name");
    expect(issue?.path).toBe("style");
    expect(issue?.message).toContain("TypeToken");
  });

  it("reports T2 and not a generic shape error", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = "color.core_neu_00";
    expect(issuesByCode(check(tree), "S12")).toEqual([]);
  });
});

describe("T3 — type tokens are already responsive", () => {
  it("rejects a Resp wrapper around Text.style", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = { base: "type.dp_2_regular", md: "type.dp_1_regular" };
    const [issue] = issuesByCode(check(tree), "T3");
    expect(issue?.nodeId).toBe("name");
    expect(issue?.message).toContain("ALREADY responsive");
  });

  it("does not also emit a shape error for the same value", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = { base: "type.dp_2_regular", md: "type.dp_1_regular" };
    expect(issuesByCode(check(tree), "S12")).toEqual([]);
  });
});

describe("T4 — breakpoint keys come from the tokens package", () => {
  it("rejects a key the tokens config does not define", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = { base: "space.5", xl: "space.6" };
    const [issue] = issuesByCode(check(tree), "T4");
    expect(issue?.message).toContain("xl");
    expect(issue?.message).toContain("md, lg");
  });

  it("accepts md and lg", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = { base: "space.5", md: "space.6", lg: "space.6" };
    expect(check(tree).errors).toEqual([]);
  });
});

describe("T5 — right shape, wrong category", () => {
  it("rejects a colour token where a space token belongs", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = "color.core_neu_00";
    const [issue] = issuesByCode(check(tree), "T5");
    expect(issue?.message).toContain("takes a space token");
    expect(issue?.message).toContain("color");
  });
});

describe("metrics", () => {
  it("counts the IR's absolute geometry as raw", () => {
    // The tree carries the Figma frame's absolute px, which is correct for a
    // fixed-aspect card the renderer scales as a whole (see designWidth).
    //
    // Worth knowing when reading this number: for such a card the absolute
    // geometry IS the design, not debt — the metric cannot tell the two apart.
    //
    // Counted against an INDEPENDENT walk of the fixture rather than a literal,
    // so editing the card to match Figma more closely does not fail a test that
    // has nothing to do with the edit. Every `_unbound` marker must land in
    // exactly one bucket, and the buckets must sum to the total.
    const m = check(card()).metrics;
    const unbound = JSON.stringify(card()).match(/"_unbound":true/g)?.length ?? 0;
    expect(unbound).toBeGreaterThan(0);
    expect(m.rawValueCount.total).toBe(unbound);
    const { total, ...buckets } = m.rawValueCount;
    expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(total);
    // Colour is fully tokenised on this card; the debt is geometry.
    expect(m.rawValueCount.color).toBe(0);
    expect(m.rawValueCount.space).toBeGreaterThan(0);
    expect(m.rawValueCount.size).toBeGreaterThan(0);
    // Anchored offsets are counted separately from sizes and gaps.
    expect(m.rawPositionCount).toBe(6);
  });

  it("counts nodes, depth, synthetic and custom", () => {
    const tree = card();
    const m = check(tree).metrics;
    expect(m.nodeCount).toBe(tree.nodes.length);
    expect(m.maxDepth).toBe(3);
    expect(m.syntheticNodeCount).toBe(0);
    expect(m.customNodeCount).toBe(0);
  });

  it("reports token coverage over values that could actually be a token", () => {
    const m = check(card()).metrics;
    const tokenisable = m.rawValueCount.total - m.rawPositionCount;
    expect(m.tokenCoverage).toBeCloseTo(
      m.tokenisedValueCount / (m.tokenisedValueCount + tokenisable),
      4,
    );
    expect(m.tokenisedValueCount).toBeGreaterThan(25);
  });

  /**
   * A coordinate has no token to bind to, so counting it caps the ratio below
   * 1 forever — the metric would measure how many Overlays a design has, not
   * how well it is tokenised. On the fixtures page 954 of 1496 raws were
   * coordinates, reporting 27% for a tree that was genuinely at 51%.
   */
  it("excludes position from coverage, and reports it undiluted instead", () => {
    const tree = card();
    const before = check(tree).metrics;

    // Pin one more node by hand: pure position debt, no token was possible.
    const node = nodeOf(tree, "stat_matches_label");
    node.props["place"] = {
      anchor: "top-start",
      offset: { block: { raw: 12, _unbound: true }, inline: { raw: 34, _unbound: true } },
    };
    const after = check(tree).metrics;

    expect(after.rawPositionCount).toBe(before.rawPositionCount + 2);
    expect(after.rawValueCount.total).toBe(before.rawValueCount.total + 2);
    // The thing that matters: coverage did not fall because of it.
    expect(after.tokenCoverage).toBeCloseTo(before.tokenCoverage, 4);
  });

  it("does NOT count percentages as raw debt — they are relative and re-theme correctly", () => {
    // The IR-derived card uses absolute px throughout, so it has none; a
    // percentage still must not be counted as raw when one appears.
    // The IR card is all absolute px, so it has none; a percentage still must
    // not be counted as raw when one appears.
    const base = check(card()).metrics;
    const tree = card();
    (nodeOf(tree, "cutout").props["size"] as Record<string, unknown>)["h"] = "91%";
    const m = check(tree).metrics;
    // A delta, not an absolute: the card already carries relative sizes of its
    // own (`"full"` where the IR says fill), and this test is about the ONE
    // value it just changed.
    expect(m.relativeValueCount).toBe(base.relativeValueCount + 1);
    // The raw it replaced is gone from the size bucket and NOT re-counted
    // anywhere else — a percentage re-themes correctly, so it is not debt.
    expect(m.rawValueCount.size).toBe(base.rawValueCount.size - 1);
    expect(m.rawValueCount.total).toBe(base.rawValueCount.total - 1);
  });

  it("still reports metrics for a tree that fails validation", () => {
    const base = check(card()).metrics;
    const tree = card();
    nodeOf(tree, "card").props["surface"] = "surface.nope";
    const result = check(tree);
    expect(result.ok).toBe(false);
    expect(result.metrics.rawValueCount.total).toBe(base.rawValueCount.total);
  });

  it("buckets duration raws separately from size raws", () => {
    const base = check(card()).metrics;
    const tree = card();
    nodeOf(tree, "name").props["revealDelay"] = { raw: 200, _unbound: true };
    const m = check(tree).metrics;
    expect(m.rawValueCount.duration).toBe(base.rawValueCount.duration + 1);
    // A duration raw must not leak into the geometry buckets.
    expect(m.rawValueCount.size).toBe(base.rawValueCount.size);
    expect(m.rawValueCount.space).toBe(base.rawValueCount.space);
    expect(m.rawValueCount.total).toBe(base.rawValueCount.total + 1);
  });
});

describe("S16 — a designed control names its Carousel", () => {
  const tree = (control: Record<string, unknown>, extra: Array<Record<string, unknown>> = []) =>
    tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:0", props: {} },
      {
        id: "c",
        parent: "root",
        idx: 0,
        type: "Carousel",
        src: "1:1",
        props: { slidesPerView: "auto", autoplay: false },
      },
      { id: "s", parent: "c", idx: 0, type: "Box", src: "1:2", props: {} },
      { id: "next", parent: "root", idx: 1, type: "Box", src: "1:3", props: { controlFor: control } },
      ...extra,
    ] as never);

  it("accepts an arrow outside the carousel that names it", () => {
    const result = check(tree({ target: "c", part: "next" }));
    expect(issuesByCode(result, "S16")).toEqual([]);
    expect(issuesByCode(result, "S12")).toEqual([]);
    // Outside the carousel, the arrow is not the S10 smell either.
    expect(issuesByCode(result, "S10")).toEqual([]);
  });

  it("rejects a target that is not a Carousel, or not in the tree", () => {
    expect(issuesByCode(check(tree({ target: "s", part: "next" })), "S16")[0]?.message).toContain("is a Box");
    expect(issuesByCode(check(tree({ target: "gone", part: "next" })), "S16")[0]?.message).toContain("not in the tree");
  });

  it("rejects a second control of the same part", () => {
    const twice = tree({ target: "c", part: "next" }, [
      { id: "next2", parent: "root", idx: 2, type: "Box", src: "1:4", props: { controlFor: { target: "c", part: "next" } } },
    ]);
    const issues = issuesByCode(check(twice), "S16");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe("next2");
  });

  it("lets each slide carry its own arrows", () => {
    const perSlide = tree({ target: "c", part: "prev" }, [
      { id: "s2", parent: "c", idx: 1, type: "Box", src: "1:5", props: {} },
      { id: "n1", parent: "s", idx: 0, type: "Box", src: "1:6", props: { controlFor: { target: "c", part: "next" } } },
      { id: "n2", parent: "s2", idx: 0, type: "Box", src: "1:7", props: { controlFor: { target: "c", part: "next" } } },
    ]);
    expect(issuesByCode(check(perSlide), "S16")).toEqual([]);
  });

  it("takes a counter as a Text with its format, and a progress bar of the autoplay", () => {
    const ok = tree({ target: "c", part: "prev" }, [
      { id: "count", parent: "root", idx: 2, type: "Text", src: "1:8", props: { content: "1 / 3", style: "type.body_sm_regular", tone: "color.text_main_high", controlFor: { target: "c", part: "counter", format: "{index} of {count}" } } },
      { id: "bar", parent: "root", idx: 3, type: "Box", src: "1:9", props: { surface: "surface.button_filled_style_1", controlFor: { target: "c", part: "progress", of: "autoplay" } } },
    ]);
    expect(issuesByCode(check(ok), "S16")).toEqual([]);
    const boxCounter = tree({ target: "c", part: "counter" });
    expect(issuesByCode(check(boxCounter), "S16")[0]?.message).toContain("a counter is a Text");
  });

  it("rejects an unknown part by its schema", () => {
    expect(issuesByCode(check(tree({ target: "c", part: "skip" })), "S12")).not.toEqual([]);
  });
});

describe("states, opacity, transform and transition on any node", () => {
  const box = (props: Record<string, unknown>) =>
    tinyTree([{ id: "b", parent: null, idx: 0, type: "Box", src: "1:1", props }] as never);

  it("takes a look per state, all in tokens", () => {
    const result = check(
      box({
        surface: "surface.button_filled_style_1",
        opacity: "opacity.100",
        transform: { scale: 1, y: "space.2", rotate: 0 },
        states: {
          hover: { transform: { scale: 1.04 } },
          pressed: { opacity: "opacity.80" },
          inactive: { opacity: "opacity.40", transform: { scale: 0.9 } },
          disabled: { opacity: "opacity.30" },
        },
        transition: { duration: "duration.base", easing: "easing.standard" },
      }),
    );
    expect(result.errors).toEqual([]);
  });

  it("refuses a state token the theme does not have, and a layout change in a state", () => {
    const bad = check(box({ states: { hover: { surface: "surface.nope" } } }));
    expect(bad.errors.length).toBeGreaterThan(0);
    const layout = check(box({ states: { hover: { size: { w: "full" } } } }));
    expect(issuesByCode(layout, "S12").length).toBeGreaterThan(0);
  });

  it("keeps a look off a Repeater, which has no box to paint", () => {
    const tree = tinyTree([
      { id: "s", parent: null, idx: 0, type: "Stack", src: "1:0", props: {} },
      { id: "r", parent: "s", idx: 0, type: "Repeater", src: "1:1", props: { over: "items", as: "item", opacity: "opacity.50" } },
      { id: "c", parent: "r", idx: 0, type: "Box", src: "1:2", props: {} },
    ] as never);
    expect(check(tree).errors.length).toBeGreaterThan(0);
  });
});
