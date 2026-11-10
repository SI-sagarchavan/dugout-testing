import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkReading,
  liftToSiblings,
  outlineOf,
  parseReading,
  readPrompt,
  unread,
} from "../src/read.ts";
import type { IrNode } from "../src/toolchain.ts";

/** The Showcase hero (Southern Brave): one story drawn, two arrows, "01", a bar, a match card pinned on it. */
const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../evals/sections/showcase.ir.json"), "utf8"),
) as { root: IrNode };
const byId = new Map<string, IrNode>();
const parents = new Map<string, string | null>();
const index = (n: IrNode, parent: string | null) => {
  byId.set(n.id, n);
  parents.set(n.id, parent);
  for (const c of n.children ?? []) index(c, n.id);
};
index(doc.root, null);
const ir = { byId, parents };

const outline = outlineOf(doc);
/** A reply that parsed: the tests below hand the reading only what parses. */
const parsed = (text: string) => {
  const raw = parseReading(text);
  if (!raw) throw new Error(`not a reading: ${text}`);
  return raw;
};
const handle = (name: string, nth = 0) => {
  const hits = [...outline.ids].filter(([, id]) => byId.get(id)?.name === name);
  const hit = hits[nth];
  if (!hit) throw new Error(`no handle for ${name}`);
  return hit[0];
};

describe("the outline the vision model names layers from", () => {
  it("starts inside the frame's lone instance, in the frame's own pixels", () => {
    expect(outline.frame).toEqual({ w: 1366, h: 768 });
    expect(outline.lines[0]).toMatch(/^h\d+ IMAGE "image 648" \[0,0 1366x906\]/);
    expect(outline.lines.join("\n")).toContain('TEXT "01" [1209,644 60x29] "01"');
  });

  it("lists a crest as one picture, not its thirty vectors", () => {
    const crest = outline.lines.find((l) => l.includes('"Frame 1321315339" [1010,167'));
    expect(crest).toContain("(picture)");
    expect(outline.lines.some((l) => l.includes('"Teams"'))).toBe(false);
    expect(outline.lines.some((l) => l.includes("clip0_160_1336"))).toBe(false);
  });

  it("puts the outline in the prompt, with the JSON it must answer", () => {
    const prompt = readPrompt(outline);
    expect(prompt).toContain("1366 x 768 px");
    expect(prompt).toContain('"slide":["h2","h6"]');
    expect(prompt).toContain(outline.lines[0]);
  });
});

describe("a reading checked against the IR", () => {
  // what a vision model says of the hero, by handle
  const reply = () =>
    JSON.stringify({
      experience: "A hero carousel of the club's top stories, with the next match pinned on it.",
      parts: [
        {
          what: "the story",
          role: "slide",
          nodes: [handle("atom_text_title"), handle("image 648")],
        },
        { what: "next match", role: "card", nodes: [handle("Frame 1984079055")] },
      ],
      layouts: [
        {
          kind: "carousel",
          // a title inside the words, and the photo beside them: the slide is the words block and the photo
          slide: [
            handle("image 648"),
            handle("Rectangle 4290"),
            handle("atom_text_title"),
            handle("atom_button"),
          ],
          controls: {
            // named as the layers are, which is the wrong way round: read by where they are
            prev: handle("back/next", 1),
            next: handle("back/next", 0),
            counter: handle("01"),
            progress: handle("Frame 1984078557"),
          },
          shows: "news stories",
          sure: 0.9,
          why: "two arrows and a 01 counter under one story",
        },
      ],
      unsure: ["Does the match card change with the story?"],
    });

  it("lifts the slide to the layers of the hero, and backs it with the controls", () => {
    const raw = parsed(`Here it is: ${reply()}`);
    const reading = checkReading(raw, outline, ir);
    const [carousel] = reading.layouts;
    expect(carousel).toMatchObject({ kind: "carousel", confidence: "certain", src: "542:10713" });
    expect(carousel?.slide).toEqual([
      "I542:10713;13020:17582",
      "I542:10713;13083:17472",
      "I542:10713;13020:17586",
    ]);
    expect(carousel?.choice).toMatchObject({
      kind: "carousel",
      config: { slidesPerView: 1 },
      slide: carousel?.slide,
    });
    // one slot: the slide, and the row that holds its arrows, counter and bar
    expect(reading.groups).toEqual([[...(carousel?.slide ?? []), "I542:10713;13020:17617"]]);
    expect(carousel?.evidence.join(" ")).toContain('a counter "01"');
  });

  it("reads the arrows by where they are, not by their names", () => {
    const reading = checkReading(parsed(reply()), outline, ir);
    const chrome = reading.layouts[0]?.chrome;
    expect(chrome?.prev).toBe("I542:10713;13020:32777");
    expect(chrome?.next).toBe("I542:10713;13020:32782");
    expect(chrome?.counter).toBe("I542:10713;13020:17627");
    expect(chrome?.progress).toBe("I542:10713;13020:17628");
  });

  it("asks what a still cannot show, the reading's own doubt included", () => {
    const reading = checkReading(parsed(reply()), outline, ir);
    expect(reading.layouts[0]?.ask.join(" ")).toContain("Does the match card change");
    expect(reading.experience).toContain("hero carousel");
    expect(reading.parts[1]?.nodes).toEqual(["I542:10713;13744:55540"]);
  });

  it("does not apply a carousel nothing drawn moves, and drops what the IR does not bear out", () => {
    const raw = parsed(
      JSON.stringify({
        layouts: [
          {
            kind: "carousel",
            slide: [handle("image 648"), handle("organism")],
            // a whole card is no arrow; a picture is no counter
            controls: { prev: handle("Frame 1984079055"), counter: handle("image 648") },
            sure: 0.95,
          },
        ],
      }),
    );
    const reading = checkReading(raw, outline, ir);
    expect(reading.layouts[0]).toMatchObject({ confidence: "unsure", alternative: "row" });
    expect(reading.groups).toEqual([]);
    expect(reading.dropped.join(" ")).toMatch(/too big for an arrow/);
    expect(reading.dropped.join(" ")).toMatch(/not a text with a number/);
  });

  it("refuses handles that are not in the outline, and a reply that is not JSON", () => {
    const reading = checkReading(
      parsed('{"layouts":[{"kind":"row","container":"h999","sure":1}]}'),
      outline,
      ir,
    );
    expect(reading.layouts).toEqual([]);
    expect(reading.dropped).toContain("h999 is not a handle of the outline");
    expect(parseReading("I think it is a carousel")).toBeUndefined();
  });

  it("lifts layers to the children of the container they share", () => {
    expect(liftToSiblings(ir, ["I542:10713;13020:17592", "I542:10713;13020:17582"])).toEqual({
      container: "542:10713",
      members: ["I542:10713;13020:17586", "I542:10713;13020:17582"],
    });
  });
});

describe("when the frame is not read", () => {
  it("makes every carousel and tabs a question, with why", () => {
    const reading = unread(
      [
        {
          src: "x",
          name: "Rail",
          kind: "carousel",
          confidence: "certain",
          items: ["a", "b"],
          evidence: ["a card cut off"],
          ask: [],
          choice: {
            src: "x",
            kind: "carousel",
            config: {
              slidesPerView: "auto",
              slidesPerGroup: 1,
              centered: false,
              initialSlide: 0,
              loop: false,
              autoplay: false,
            },
          },
          chrome: {},
        },
      ],
      "vision is down",
    );
    expect(reading.layouts[0]).toMatchObject({ confidence: "unsure", alternative: "row" });
    expect(reading.layouts[0]?.ask).toEqual(['Is "Rail" a carousel?']);
  });
});

describe("a reading on the band around a carousel", () => {
  const node = (
    id: string,
    name: string,
    box: [number, number, number, number],
    children: IrNode[] = [],
  ) =>
    ({
      id,
      name,
      type: "FRAME",
      geometry: { bbox: { x: box[0], y: box[1], w: box[2], h: box[3] } },
      children,
    }) as IrNode;
  const cards = Array.from({ length: 5 }, (_, i) => node(`c${i}`, "card", [i * 300, 40, 281, 260]));
  const row = node("row", "cards", [0, 40, 1366, 260], cards);
  const strip = node("strip", "Group 1321315017", [0, 0, 1366, 312], [row]);
  const root = node("root", "Team", [0, 0, 1366, 312], [strip, node("pad", "pad", [0, 0, 10, 10])]);
  const byId = new Map<string, IrNode>();
  const parents = new Map<string, string | null>();
  const walk = (n: IrNode, p: string | null) => {
    byId.set(n.id, n);
    parents.set(n.id, p);
    for (const c of n.children ?? []) walk(c, n.id);
  };
  walk(root, null);
  const stripOutline = outlineOf({ root });
  const stripHandle = [...stripOutline.ids].find(([, id]) => id === "strip")?.[0] as string;

  const detected = [
    {
      src: "row",
      name: "cards",
      kind: "carousel" as const,
      confidence: "certain" as const,
      items: cards.map((c) => c.id),
      evidence: ["a card cut off by the edge"],
      ask: [],
      choice: {
        src: "row",
        kind: "carousel" as const,
        config: {
          slidesPerView: "auto" as const,
          slidesPerGroup: 1,
          centered: true,
          initialSlide: 2,
          loop: false,
          autoplay: false as const,
        },
      },
      chrome: {},
    },
  ];

  it("is the carousel the IR finds inside the band, applied when the two agree", () => {
    const raw = parsed(
      JSON.stringify({ layouts: [{ kind: "carousel", container: stripHandle, sure: 0.5 }] }),
    );
    const reading = checkReading(raw, stripOutline, { byId, parents }, detected);
    const carousel = reading.layouts.find((l) => l.choice.kind === "carousel");
    expect(carousel).toMatchObject({ src: "row", confidence: "certain" });
    // what the IR measures stays: centred on the third card
    expect(carousel?.choice).toMatchObject({ config: { centered: true, initialSlide: 2 } });
    expect(reading.layouts.filter((l) => l.src === "row")).toHaveLength(1);
  });

  it("is the same when the reading names the cards' row as its one item", () => {
    const rowHandle = [...stripOutline.ids].find(([, id]) => id === "row")?.[0] as string;
    const raw = parsed(
      JSON.stringify({ layouts: [{ kind: "carousel", items: [rowHandle], sure: 0.7 }] }),
    );
    const reading = checkReading(raw, stripOutline, { byId, parents }, detected);
    expect(reading.layouts.find((l) => l.choice.kind === "carousel")).toMatchObject({
      src: "row",
      confidence: "certain",
    });
  });
});

describe("a grid on one line", () => {
  it("is a row when the IR lays its items in one row", () => {
    const raw = parsed(
      JSON.stringify({
        layouts: [
          {
            kind: "grid",
            items: [handle("Frame 1984079083"), handle("Frame 1984079037")],
            sure: 0.9,
          },
        ],
      }),
    );
    // two layers stacked in the match card: one column, so a list
    const reading = checkReading(raw, outline, ir);
    expect(reading.layouts[0]?.choice.kind).toBe("list");
  });
});

describe("a reply with nulls", () => {
  it("reads null as left out, not as a layout to throw away", () => {
    const raw = parseReading(
      '{"experience":"x","layouts":[{"kind":"carousel","container":null,"items":null,"slide":["h1"],"controls":{"prev":"h9","next":null,"pagination":null},"selected":null,"sure":0.9}],"unsure":null}',
    );
    expect(raw?.layouts).toHaveLength(1);
    expect(raw?.layouts[0]?.controls).toEqual({ prev: "h9" });
  });
});
