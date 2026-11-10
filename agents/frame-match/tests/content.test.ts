import { describe, expect, it } from "vitest";
import { applyContentVerdict, contentOf, contentPrompt, outlineOf } from "../src/content.ts";
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
    expect(content.evidence).toContain('"THE BRAVE SQUAD" is a heading or label');
    expect(content.evidence).toContain('"VIEW MORE" is a button\'s label');
    expect(content.evidence.some((e) => e.includes("is tabs"))).toBe(true);
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

  it("reads a score, a date, a long headline and placeholder copy as data", () => {
    for (const said of [
      "184/6 (20 ov)",
      "Sat 4 Jul, 14:30",
      "Southern Brave beat Welsh Fire by six wickets to go top of the table at the Utilita Bowl",
      "Player Name",
    ]) {
      expect(contentOf({ nodes: [...header(), text("x", said)] }, []).data, said).toBe("some");
    }
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

describe("a model settling an unsure section", () => {
  const unsure = { data: "unsure" as const, evidence: ["a picture 320×240px"] };

  it("takes a sure answer", () => {
    const content = applyContentVerdict(
      unsure,
      '{"data":"none","confidence":0.9,"reason":"a decorative banner"}',
    );
    expect(content.data).toBe("none");
    expect(content.evidence.at(-1)).toContain("a decorative banner");
  });

  it("leaves it unsure on a doubtful answer, or one that is not the JSON asked for", () => {
    expect(applyContentVerdict(unsure, '{"data":"none","confidence":0.5}').data).toBe("unsure");
    expect(applyContentVerdict(unsure, "it is probably static").data).toBe("unsure");
  });

  it("is asked with the section's outline", () => {
    const prompt = contentPrompt(outlineOf({ nodes: header() }), unsure);
    expect(prompt).toContain('Text title "THE BRAVE SQUAD"');
    expect(prompt).toContain("Stack men (tab)");
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
