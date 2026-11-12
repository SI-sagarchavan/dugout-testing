import { randomUUID } from "node:crypto";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  createHashMultimodalEmbeddings,
  createSectionLibrary,
  type NewSection,
  searchLibrary,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const library = createSectionLibrary({ pool, embeddings: createHashMultimodalEmbeddings() });

let a: string;
let b: string;
let word: string;
beforeEach(() => {
  const suffix = randomUUID().slice(0, 8);
  a = `t-a-${suffix}`;
  b = `t-b-${suffix}`;
  word = `zq${suffix.replace(/[^a-z]/g, "x")}`;
});

const section = (signature: string): NewSection => ({
  signature,
  name: "Southern Brave fixtures",
  kind: "fixtures",
  layout: "carousel",
  summary: "1366×300; row [3× column [image, text]]",
  caption: `A strip of upcoming fixtures ${word}`,
  tags: ["fixtures strip"],
  box: { x: 0, y: 0, w: 1366, h: 300 },
  cropKey: `${a}/${signature}.png`,
  cropWidth: 2048,
  cropHeight: 450,
  crop: Buffer.from(signature),
  skeleton: { w: 1366, h: 300, shapes: [{ kind: "image", x: 0, y: 0, w: 300, h: 200, r: 8 }] },
  source: {
    handoffId: "h1",
    irRef: "ir",
    nodeId: "1:1",
    fileKey: null,
    at: "2026-11-06T00:00:00Z",
  },
});

describe("searchLibrary", () => {
  it("gives a club's own section its picture, skeleton and DSL subtree", async () => {
    const { section: mine } = await library.add(a, section("s:strip"));
    const tree = {
      nodes: [{ id: "n1", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} }],
    };
    await library.setTree(a, mine.id, tree);
    const { items: found } = await searchLibrary(library, { tenantId: a, text: word });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      own: true,
      name: "Southern Brave fixtures",
      kind: "fixtures",
      picture: { key: `${a}/s:strip.png`, width: 2048, height: 450 },
      tree,
    });
    expect(found[0]?.skeletonSvg).toContain("<svg");
  });

  it("gives another club only the skeleton: no picture, tree, name or sources", async () => {
    const { section: mine } = await library.add(a, section("s:strip"));
    await library.setTree(a, mine.id, { nodes: [] });
    await library.markPreviewed(a, {
      runId: randomUUID(),
      agentId: "frame-match",
      handoffId: "h1",
      previewUrl: "http://localhost:3000/preview/default/t",
      at: "2026-11-06T00:00:00Z",
    });
    expect((await searchLibrary(library, { tenantId: b, text: word })).items).toEqual([]);
    // the test database keeps every run's shared sections, so look for this one by its id
    const { items: found } = await searchLibrary(library, {
      tenantId: b,
      text: word,
      scope: "shared",
    });
    const theirs = found.find((f) => f.id === mine.id);
    expect(theirs).toMatchObject({ own: false, name: "", picture: null, tree: null });
    expect(theirs?.skeletonSvg).toContain("<svg");
    expect(JSON.stringify(theirs)).not.toContain("Southern Brave");
  });

  it("finds by a picture alone, and refuses an empty ask", async () => {
    await library.add(a, section("s:strip"));
    const { items: found } = await searchLibrary(library, {
      tenantId: a,
      image: Buffer.from("s:strip"),
    });
    expect(found.map((f) => f.kind)).toContain("fixtures");
    await expect(searchLibrary(library, { tenantId: a, text: "  " })).rejects.toThrow(/phrase/);
  });

  it("pages the results: a page of `limit`, then where the next one starts", async () => {
    for (const n of [1, 2, 3, 4, 5]) await library.add(a, section(`s:page${n}`));
    const first = await searchLibrary(library, { tenantId: a, text: word, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first).toMatchObject({ hasMore: true, nextOffset: 2 });
    const last = await searchLibrary(library, { tenantId: a, text: word, limit: 2, offset: 4 });
    expect(last.items).toHaveLength(1);
    expect(last).toMatchObject({ hasMore: false, nextOffset: null });
    const ids = [
      ...first.items,
      ...(await searchLibrary(library, { tenantId: a, text: word, limit: 2, offset: 2 })).items,
      ...last.items,
    ].map((f) => f.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("leaves out sections that are not close to the question", async () => {
    const strict = createSectionLibrary({
      pool,
      embeddings: createHashMultimodalEmbeddings(),
      relevance: { textFloor: 0.2, textGap: 0.06, imageFloor: 0.3, imageGap: 0.12 },
    });
    await strict.add(a, section("s:near"));
    await strict.add(a, {
      ...section("s:far"),
      name: "Standings",
      kind: "standings",
      layout: "none",
      caption: "A league table of points",
      tags: ["table"],
    });
    const open = await searchLibrary(library, { tenantId: a, text: `fixtures ${word}` });
    expect(open.items).toHaveLength(2);
    const near = await searchLibrary(strict, { tenantId: a, text: `fixtures ${word}` });
    expect(near.items.map((f) => f.kind)).toEqual(["fixtures"]);
  });
});
