import { randomUUID } from "node:crypto";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  createHashMultimodalEmbeddings,
  createSectionLibrary,
  type NewSection,
  type SectionLibrary,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const library: SectionLibrary = createSectionLibrary({
  pool,
  embeddings: createHashMultimodalEmbeddings(),
});

let a: string;
let b: string;
beforeEach(() => {
  const suffix = randomUUID().slice(0, 8);
  a = `t-a-${suffix}`;
  b = `t-b-${suffix}`;
});

const section = (signature: string, over: Partial<NewSection> = {}): NewSection => ({
  signature,
  name: "Frame",
  kind: "other",
  layout: "none",
  summary: "1440×400; row [3× column [image, text]]",
  caption: "",
  tags: [],
  box: { x: 0, y: 0, w: 1440, h: 400 },
  cropKey: `k/${signature}.png`,
  cropWidth: 2880,
  cropHeight: 800,
  crop: Buffer.from(`picture of ${signature}`),
  source: {
    handoffId: "h1",
    irRef: "ir1",
    nodeId: "1:1",
    fileKey: "f",
    at: "2026-11-06T00:00:00Z",
  },
  ...over,
});

describe("section library", () => {
  it("keeps one row per shape and one source per sighting", async () => {
    const first = await library.add(a, section("s2:aa"));
    expect(first.created).toBe(true);

    const again = await library.add(a, section("s2:aa"));
    expect(again).toMatchObject({ created: false, section: { id: first.section.id } });
    expect(again.section.sources).toHaveLength(1);

    const elsewhere = await library.add(
      a,
      section("s2:aa", {
        source: {
          handoffId: "h2",
          irRef: "ir2",
          nodeId: "9:9",
          fileKey: null,
          at: "2026-11-07T00:00:00Z",
        },
      }),
    );
    expect(elsewhere.section.sources.map((s) => s.handoffId)).toEqual(["h1", "h2"]);
  });

  it("shows a tenant only its own sections", async () => {
    const { section: mine } = await library.add(
      a,
      section("s2:mine", { caption: "standings table" }),
    );
    expect(await library.get(b, mine.id)).toBeUndefined();
    expect(await library.findBySignature(b, "s2:mine")).toBeUndefined();
    expect(await library.search(b, { text: "standings table" })).toEqual([]);
    const seen = await withTenant(pool, b, (db) =>
      db.query("select id from library_sections where id = $1", [mine.id]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it("finds a section by words in its caption, tags or structure", async () => {
    await library.add(
      a,
      section("s2:news", {
        kind: "news",
        caption: "Grid of news articles with a lead story",
        tags: ["news grid"],
      }),
    );
    await library.add(
      a,
      section("s2:table", {
        kind: "standings",
        caption: "League standings table with points and form",
        tags: ["league table"],
      }),
    );
    await library.add(
      a,
      section("s2:fix", {
        kind: "fixtures",
        layout: "carousel",
        caption: "Carousel of upcoming fixtures with both crests",
        tags: ["fixtures"],
      }),
    );

    const [top] = await library.search(a, { text: "league standings table" });
    expect(top?.signature).toBe("s2:table");

    const carousels = await library.search(a, { text: "crests", layout: "carousel" });
    expect(carousels.map((s) => s.signature)).toEqual(["s2:fix"]);

    const news = await library.search(a, { text: "articles", kind: "news" });
    expect(news.map((s) => s.signature)).toEqual(["s2:news"]);
  });

  it("finds a section by its picture", async () => {
    await library.add(a, section("s2:one"));
    await library.add(a, section("s2:two"));
    const [top] = await library.search(a, { image: Buffer.from("picture of s2:two") });
    expect(top?.signature).toBe("s2:two");
  });

  it("keeps a person's tags and removals when a model describes the section again", async () => {
    const { section: s } = await library.add(a, section("s2:hero", { tags: ["banner", "hero"] }));
    await library.editTags(a, s.id, { add: ["Homepage Hero"], remove: ["banner"] });
    const redone = await library.describe(a, s.id, {
      caption: "A full-width hero with a headline over a photo",
      kind: "hero",
      tags: ["banner", "hero", "photo"],
    });
    expect(redone.tags).toEqual(["hero", "photo", "homepage hero"]);
    expect(redone.kind).toBe("hero");

    const [top] = await library.search(a, { text: "homepage hero" });
    expect(top?.id).toBe(s.id);
  });

  it("leaves hidden sections out of search", async () => {
    const { section: s } = await library.add(a, section("s2:gone", { caption: "ticket block" }));
    await library.setHidden(a, s.id, true);
    expect(await library.search(a, { text: "ticket block" })).toEqual([]);
    await library.setHidden(a, s.id, false);
    expect((await library.search(a, { text: "ticket block" })).map((r) => r.id)).toEqual([s.id]);
  });

  it("needs words or a picture to search", async () => {
    await expect(library.search(a, {})).rejects.toThrow(/words, an image, or both/);
  });
});
