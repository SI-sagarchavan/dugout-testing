import { describe, expect, it } from "vitest";
import {
  addPaintVotes,
  approvedPalette,
  emptyVotes,
  type IrNode,
  NEUTRAL_PALETTE,
  PALETTE_FACT,
  paletteFact,
  paletteFromVotes,
  parsePaletteFact,
  proposePalette,
  roleOf,
  themeColours,
} from "../src/index.ts";

const theme = {
  tokens: {
    set1: {
      color: {
        dark: { background_main_surface: "#000000" },
        light: {
          background_main_surface: "#ffffff",
          background_main_card: "#eeeeee",
          background_prim_card: "#e10a15",
          text_main_default: "#212121",
          text_prim_default: "#fff5f6",
        },
      },
    },
  },
};

let n = 0;
const box = (w: number, h: number, extra: Partial<IrNode> = {}): IrNode => ({
  id: `n${n++}`,
  name: "layer",
  type: "FRAME",
  geometry: { bbox: { x: 0, y: 0, w, h } },
  ...extra,
});
const text = (token: string, w = 200) =>
  box(w, 20, { type: "TEXT", fill: { tokenRef: token }, text: { characters: "x" } });

describe("themeColours", () => {
  it("reads a token ref through the theme's light colours; a raw colour wins", () => {
    const colour = themeColours(theme);
    expect(colour({ tokenRef: "background/main/surface" })).toBe("#ffffff");
    expect(colour({ tokenRef: "background/prim/card" })).toBe("#e10a15");
    expect(colour({ tokenRef: "background/prim/card", raw: "#123456" })).toBe("#123456");
    expect(colour({ tokenRef: "nowhere" })).toBeUndefined();
  });
});

describe("the palette from a tenant's designs", () => {
  const section = box(1366, 600, {
    fill: { tokenRef: "background/main/surface" },
    children: [
      box(400, 300, {
        fill: { tokenRef: "background/main/card" },
        children: [text("text/main/default")],
      }),
      box(300, 200, {
        fill: { tokenRef: "background/prim/card" },
        children: [text("text/prim/default")],
      }),
      // a headline over a photo, in white: the photo's colours, not the design's
      box(400, 300, {
        children: [box(400, 300, { type: "IMAGE", image: {} }), text("text/prim/default", 380)],
      }),
    ],
  });

  it("counts the page, cards, accents and the text on each, by area, and leaves out text on pictures", () => {
    const votes = emptyVotes();
    addPaintVotes(votes, section, themeColours(theme));
    expect([...votes.page.keys()]).toEqual(["#ffffff"]);
    expect([...votes.surface.keys()]).toEqual(["#eeeeee"]);
    expect([...votes.accent.keys()]).toEqual(["#e10a15"]);
    expect([...votes.ink]).toEqual([["#212121", 4000]]);
    expect([...votes.onAccent.keys()]).toEqual(["#fff5f6"]);

    const palette = paletteFromVotes(votes);
    expect(palette).toMatchObject({ page: "#ffffff", surface: "#eeeeee", accent: "#e10a15" });
    // bars are quieter than text, and still read on what they are drawn on
    expect(palette?.ink).not.toBe("#212121");
    expect(palette?.ink).not.toBe(palette?.surface);
  });

  it("takes no text colour that would not read on the cards", () => {
    const votes = emptyVotes();
    votes.page.set("#ffffff", 10);
    votes.surface.set("#eeeeee", 10);
    votes.ink.set("#fafafa", 1000);
    votes.ink.set("#1f2b7b", 10);
    expect(paletteFromVotes(votes)?.ink).toBe(
      paletteFromVotes({ ...votes, ink: new Map([["#1f2b7b", 1]]) })?.ink,
    );
    expect(paletteFromVotes(emptyVotes())).toBeUndefined();
  });

  it("is kept as a fact a person reads, and read back from it", () => {
    const votes = emptyVotes();
    addPaintVotes(votes, section, themeColours(theme));
    const palette = paletteFromVotes(votes);
    if (!palette) throw new Error("no palette");
    const fact = paletteFact(palette);
    expect(fact).toMatch(
      /^Other clubs' sections .* page #ffffff, cards #eeeeee, accent #e10a15, text #/,
    );
    expect(parsePaletteFact(fact)).toEqual(palette);
    // a person's edit of one colour, the rest neutral
    expect(parsePaletteFact("drawn in: accent #00ff00.")).toEqual({
      ...NEUTRAL_PALETTE,
      accent: "#00ff00",
    });
    expect(parsePaletteFact("no colours here")).toBeUndefined();
  });
});

describe("roleOf", () => {
  it("reads prim tokens as accents, and a token that says neither by its colour", () => {
    expect(roleOf({ tokenRef: "background/prim/card" })).toBe("accent");
    expect(roleOf({ tokenRef: "background/main/surface", raw: "#212121" })).toBe("surface");
    expect(roleOf({ tokenRef: "background/invert/surface", raw: "#212121" })).toBe("accent");
    expect(roleOf({ tokenRef: "background/invert/surface" })).toBe("surface");
  });
});

describe("proposePalette", () => {
  const memory = () => {
    const active: Array<{ key: string | null; content: string }> = [];
    const proposed: Array<{ key: string | null; content: string }> = [];
    return {
      active,
      proposed,
      activeFacts: async () => active,
      listProposals: async () => proposed,
      proposeFact: async (f: { key: string; content: string }) => {
        proposed.push(f);
        return f;
      },
    };
  };
  const red = { ...NEUTRAL_PALETTE, accent: "#e10a15" };
  const blue = { ...NEUTRAL_PALETTE, accent: "#2939a3" };

  it("proposes a palette for a person to approve, once", async () => {
    const m = memory();
    expect(await proposePalette({ memory: m, tenantId: "t", palette: red })).toBe(true);
    expect(m.proposed).toEqual([
      expect.objectContaining({ key: PALETTE_FACT, content: paletteFact(red) }),
    ]);
    expect(await proposePalette({ memory: m, tenantId: "t", palette: red })).toBe(false);
    // the worker proposes only a first one; a person asks for another with the command
    expect(await proposePalette({ memory: m, tenantId: "t", palette: blue, onlyFirst: true })).toBe(
      false,
    );
    expect(await proposePalette({ memory: m, tenantId: "t", palette: blue })).toBe(true);
  });

  it("reads the approved one", async () => {
    const m = memory();
    expect(await approvedPalette(m, "t")).toBeUndefined();
    m.active.push({ key: PALETTE_FACT, content: paletteFact(blue) });
    expect(await approvedPalette(m, "t")).toEqual(blue);
  });
});
