import { describe, expect, it } from "vitest";
import { contentOf, settledContent, signsOf } from "../src/content.ts";
import type { LayoutReport } from "../src/layout.ts";

type Node = {
  id: string;
  parent: string | null;
  type: string;
  src?: string;
  props: Record<string, unknown>;
};
const text = (id: string, content: string, parent = "root"): Node => ({
  id,
  parent,
  type: "Text",
  props: { content },
});

/** THE BRAVE SQUAD, a WOMEN | MEN toggle and VIEW MORE: the header over the squad strip. */
const header = (): Node[] => [
  { id: "root", parent: null, type: "Stack", props: {} },
  text("title", "THE BRAVE SQUAD"),
  {
    id: "women",
    parent: "root",
    type: "Stack",
    props: { select: { key: "women_men", value: "women" } },
  },
  text("women_label", "WOMEN", "women"),
  {
    id: "men",
    parent: "root",
    type: "Stack",
    props: { select: { key: "women_men", value: "men", initial: true } },
  },
  text("men_label", "MEN", "men"),
  { id: "more", parent: "root", type: "Button", props: { label: "VIEW MORE" } },
];
const tabs: LayoutReport = {
  src: "35:10515",
  name: "Frame 1984078920",
  kind: "tabs",
  confidence: "likely",
  evidence: [],
  left: [],
  choice: { src: "35:10515", kind: "tabs", config: { options: ["WOMEN", "MEN"], active: 1 } },
  applied: true,
  decided: false,
};

describe("whether a section shows data", () => {
  it("reads a heading, tabs and a button as a section with nothing to bind", () => {
    const content = contentOf({ nodes: header() }, [tabs]);
    expect(content.data).toBe("none");
    expect(content.evidence).toContain('"THE BRAVE SQUAD" is a short text');
    expect(content.evidence).toContain('"VIEW MORE" is a button\'s label');
    expect(content.evidence.some((e) => e.includes("is proposed as tabs"))).toBe(true);
  });

  it("reads what repeats as data", () => {
    const list: LayoutReport = {
      ...tabs,
      name: "players",
      kind: "carousel",
      choice: { src: "x", kind: "list" },
    };
    expect(contentOf({ nodes: header() }, [list]).data).toBe("some");
  });

  it("proposes data for text shaped like a value: two numbers joined, a date, a time, long prose, lorem ipsum", () => {
    for (const said of [
      "184/6 (20 ov)",
      "Sat 4 Jul",
      "Kick-off 14:30",
      "The home side won by six wickets to go top of the table at the ground on Saturday",
      "Lorem ipsum dolor",
    ]) {
      expect(contentOf({ nodes: [...header(), text("x", said)] }, []).data, said).toBe("some");
    }
  });

  it("knows no subject's words: a placeholder name is a short text, its layer's name reported", () => {
    const nodes = [...header(), { ...text("x", "Player Name"), src: "1:2" }];
    const signs = signsOf({ nodes }, [], undefined, (src) =>
      src === "1:2" ? "athlete/name" : undefined,
    );
    expect(signs.copy).toContain('"Player Name" (layer "athlete/name") is a short text');
    expect(signs.data).toEqual([]);
  });

  it("reports a number in short text without leaning either way", () => {
    const content = contentOf({ nodes: [...header(), text("x", "TOP 10")] }, []);
    expect(content.data).toBe("unsure");
    expect(content.evidence).toContain('"TOP 10" holds a number');
  });

  it("does not take a heading with a number in it for data", () => {
    expect(contentOf({ nodes: [...header(), text("x", "THE HUNDRED")] }, []).data).toBe("none");
  });

  it("is unsure of a photo-sized picture, which may be art or a photo of a player", () => {
    const nodes = [
      ...header(),
      { id: "pic", parent: "root", type: "Image", src: "9:9", props: {} },
    ];
    const content = contentOf({ nodes }, [], (src) =>
      src === "9:9" ? { w: 320, h: 240 } : undefined,
    );
    expect(content.data).toBe("unsure");
    expect(contentOf({ nodes }, [], () => ({ w: 40, h: 40 })).data).toBe("none");
  });
});

describe("what the agent settled", () => {
  it("is the section's content, its why first and the signs after", () => {
    const proposal = { data: "unsure" as const, evidence: ["a picture 320×240px"] };
    const content = settledContent(proposal, { data: "none", why: "a decorative banner" });
    expect(content).toEqual({
      data: "none",
      evidence: ["decided: a decorative banner", "a picture 320×240px"],
      why: "a decorative banner",
      by: "agent",
    });
  });
});

describe("a section's name", () => {
  it("is its frame's, or the first thing it says when Figma named the frame", async () => {
    const { sectionName } = await import("../src/tools.ts");
    const tree = {
      nodes: [
        { type: "Stack", props: {} },
        { type: "Text", props: { content: "THE BRAVE SQUAD" } },
      ],
    };
    expect(sectionName("Frame 1984078815", tree)).toBe("THE BRAVE SQUAD");
    expect(sectionName("Squad header", tree)).toBe("Squad header");
  });
});
