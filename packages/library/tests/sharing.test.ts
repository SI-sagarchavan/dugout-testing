import { randomUUID } from "node:crypto";
import { createPool, withTenant } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  createHashMultimodalEmbeddings,
  createSectionLibrary,
  type IndexReport,
  type NewSection,
  type SectionLibrary,
  type ShapeReader,
  syncPreviews,
} from "../src/index.ts";

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const library: SectionLibrary = createSectionLibrary({
  pool,
  embeddings: createHashMultimodalEmbeddings(),
});

let a: string;
let b: string;
/** A word no other test's sections have: the test database keeps every run's shared sections. */
let word: string;
beforeEach(() => {
  const suffix = randomUUID().slice(0, 8);
  a = `t-a-${suffix}`;
  b = `t-b-${suffix}`;
  word = `w${suffix.replace(/-/g, "")}`;
});

/** The ids a search finds; the shared pool holds other tests' sections too. */
const ids = async (tenant: string, text: string, scope: "own" | "shared" = "own") =>
  (await library.search(tenant, { text: `${text} ${word}`, scope, limit: 50 })).map((r) => r.id);

const section = (signature: string, handoffId: string, caption: string): NewSection => ({
  signature,
  name: "Southern Brave fixtures",
  kind: "fixtures",
  layout: "carousel",
  summary: "1366×300; row [3× column [image, text]]",
  caption: `${caption} ${word}`,
  tags: ["fixtures carousel"],
  box: { x: 0, y: 0, w: 1366, h: 300 },
  cropKey: `${signature}.png`,
  cropWidth: 2048,
  cropHeight: 450,
  crop: Buffer.from(signature),
  skeleton: { w: 1366, h: 300, shapes: [{ kind: "image", x: 0, y: 0, w: 300, h: 200, r: 8 }] },
  source: { handoffId, irRef: "ir", nodeId: "1:1", fileKey: null, at: "2026-11-06T00:00:00Z" },
});

const preview = (handoffId: string, runId = randomUUID()) => ({
  runId,
  agentId: "frame-match",
  handoffId,
  previewUrl: `http://localhost:3000/preview/default/${runId}`,
  at: "2026-11-06T10:00:00.000Z",
});

describe("sharing across tenants", () => {
  it("shares a section with other tenants once a preview was built from it", async () => {
    const { section: mine } = await library.add(
      a,
      section("s2:fix", "h1", "Carousel of fixture cards"),
    );
    expect(await ids(b, "fixture cards", "shared")).not.toContain(mine.id);

    expect(await library.markPreviewed(a, preview("h1"))).toBe(1);
    const theirs = (
      await library.search(b, { text: `fixture cards ${word}`, scope: "shared" })
    ).find((r) => r.id === mine.id);
    expect(theirs).toMatchObject({
      id: mine.id,
      own: false,
      caption: `Carousel of fixture cards ${word}`,
      tags: ["fixtures carousel"],
      // what names the club, shows its pictures, or says where it was sent stays the club's
      tenantId: "",
      name: "",
      cropKey: null,
      sources: [],
      previews: [],
    });
    expect(theirs?.skeleton?.shapes).toHaveLength(1);
    expect(await library.get(b, mine.id)).toMatchObject({ own: false, cropKey: null });

    // the tenant's own search is its own only, unless it asks for the shared pool
    expect(await ids(b, "fixture cards")).toEqual([]);
    const own = (await library.search(a, { text: `fixture cards ${word}`, scope: "shared" })).find(
      (r) => r.id === mine.id,
    );
    expect(own).toMatchObject({
      own: true,
      cropKey: "s2:fix.png",
      name: "Southern Brave fixtures",
    });
  });

  it("counts each preview run once, and keeps the first preview's time", async () => {
    await library.add(a, section("s2:once", "h1", "x"));
    const p = preview("h1");
    expect(await library.markPreviewed(a, p)).toBe(1);
    expect(await library.markPreviewed(a, p)).toBe(0);
    await library.markPreviewed(a, { ...preview("h1"), at: "2026-11-07T10:00:00.000Z" });
    const s = await library.findBySignature(a, "s2:once");
    expect(s?.previews).toHaveLength(2);
    expect(s?.previewedAt).toBe("2026-11-06T10:00:00.000Z");
  });

  it("keeps a tenant's sections to itself once it stops sharing", async () => {
    const { section: s } = await library.add(a, section("s2:off", "h1", "News grid"));
    await library.markPreviewed(a, preview("h1"));
    expect(await library.sharing(a)).toBe(true);
    await library.setSharing(a, false);
    expect(await ids(b, "news grid", "shared")).not.toContain(s.id);
    expect(await ids(a, "news grid")).toEqual([s.id]);
    await library.setSharing(a, true);
    expect(await ids(b, "news grid", "shared")).toContain(s.id);
  });

  it("lets no tenant change another's sections or say whether another shares", async () => {
    const { section: mine } = await library.add(a, section("s2:mine", "h1", "Hero"));
    await library.markPreviewed(a, preview("h1"));
    await expect(library.setHidden(b, mine.id, true)).rejects.toThrow(/not found/);
    await expect(
      library.describe(b, mine.id, { caption: "x", kind: "other", tags: [] }),
    ).rejects.toThrow(/not found/);
    const raw = await withTenant(pool, b, (db) =>
      db.query("update library_sections set caption = 'x' where id = $1", [mine.id]),
    );
    expect(raw.rowCount).toBe(0);
    await expect(
      withTenant(pool, b, (db) =>
        db.query("insert into library_tenants (tenant_id, shares) values ($1, false)", [a]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("leaves hidden sections out of the shared pool", async () => {
    const { section: s } = await library.add(a, section("s2:hid", "h1", "Ticket block"));
    await library.markPreviewed(a, preview("h1"));
    await library.setHidden(a, s.id, true);
    expect(await ids(b, "ticket block", "shared")).not.toContain(s.id);
    expect(await library.get(b, s.id)).toBeUndefined();
  });
});

describe("syncPreviews", () => {
  const run = (
    tenant: string,
    agentId: string,
    input: object,
    previewUrl?: string,
    status = "completed",
  ) =>
    withTenant(pool, tenant, (db) =>
      db.query(
        "insert into runs (id, tenant_id, agent_id, status, input, result) values ($1, $2, $3, $4, $5, $6)",
        [
          randomUUID(),
          tenant,
          agentId,
          status,
          input,
          previewUrl ? { output: { previewUrl } } : null,
        ],
      ),
    );

  it("indexes a previewed Handoff the library has not seen, and marks its sections", async () => {
    await run(a, "frame-match", { handoffId: "h9", project: "default" }, "http://p/1");
    await run(a, "section-builder", { handoffId: "h9" }, "http://p/2");
    await run(a, "frame-match", { handoffId: "h-failed" }, undefined, "failed");
    await run(a, "data-bind", { preview: "http://p/1" }, "http://p/3");

    const indexed: string[] = [];
    const index = async (r: { handoff: { id: string } }): Promise<IndexReport> => {
      indexed.push(r.handoff.id);
      await library.add(a, section("s2:h9", r.handoff.id, "Standings table"));
      return {
        handoffId: r.handoff.id,
        rootName: "Standings",
        added: [],
        seen: [],
        skipped: [],
        failed: [],
      };
    };
    const first = await syncPreviews({ pool, tenantId: a, library, index });
    expect(first.runs).toBe(2);
    expect(indexed).toEqual(["h9"]);
    expect(first.marked.map((m) => m.sections)).toEqual([1, 1]);
    expect((await library.findBySignature(a, "s2:h9"))?.previews).toHaveLength(2);

    const again = await syncPreviews({ pool, tenantId: a, library, index });
    expect(indexed).toEqual(["h9"]);
    expect(again.marked.map((m) => m.sections)).toEqual([0, 0]);
    const shared = await library.findBySignature(a, "s2:h9");
    expect(await ids(b, "standings table", "shared")).toContain(shared?.id);
  });

  it("gives a bound preview's sections their data shape, and finds a data-bind run's Handoff by its tree", async () => {
    const tree = randomUUID();
    const link = `http://localhost:3000/preview/default/${tree}?theme=t`;
    await run(a, "frame-match", { handoffId: "h-news" }, link);
    await run(a, "data-bind", { preview: link }, `${link}&data=d1&plan=p1`);
    await library.add(a, {
      ...section("s:news", "h-news", "News cards"),
      source: { ...section("s:news", "h-news", "").source, nodeId: "2:1" },
    });
    await library.add(a, {
      ...section("s:footer", "h-news", "Footer"),
      source: { ...section("s:footer", "h-news", "").source, nodeId: "3:1" },
    });

    const shapes: ShapeReader = {
      ir: async () => ({
        rootNodeId: "1:1",
        root: {
          id: "1:1",
          name: "Page",
          type: "FRAME",
          geometry: { bbox: { x: 0, y: 0, w: 1366, h: 900 } },
          children: [
            {
              id: "2:1",
              name: "News",
              type: "FRAME",
              geometry: { bbox: { x: 0, y: 0, w: 1366, h: 600 } },
              children: [
                {
                  id: "I2:5;9:1",
                  name: "title",
                  type: "TEXT",
                  geometry: { bbox: { x: 0, y: 0, w: 300, h: 20 } },
                },
              ],
            },
            {
              id: "3:1",
              name: "Footer",
              type: "FRAME",
              geometry: { bbox: { x: 0, y: 600, w: 1366, h: 300 } },
            },
          ],
        },
      }),
      artifact: async (_run, id) =>
        id === "p1"
          ? { bind: [{ path: "news.articles.0.title", prop: "content", src: "I2:5;9:1" }] }
          : { news: { articles: [{ title: "A headline nobody else may read" }] } },
    };
    const index = async (): Promise<IndexReport> => {
      throw new Error("the Handoff is in the library already");
    };
    const first = await syncPreviews({ pool, tenantId: a, library, index, shapes });
    expect(first.failed).toEqual([]);
    expect(first.marked.map((m) => m.sections)).toEqual([2, 2]);
    expect(first.shaped).toEqual([expect.objectContaining({ handoffId: "h-news", sections: 1 })]);

    const news = await library.findBySignature(a, "s:news");
    expect(news?.dataShape).toEqual({
      lists: [
        { path: "news.articles", items: 1, looks: 1, fields: [{ path: "title", type: "text" }] },
      ],
      fields: [],
    });
    expect((await library.findBySignature(a, "s:footer"))?.dataShape).toBeNull();
    // another club finds it by the data it shows, and reads the shape, never the values
    expect(await ids(b, "news articles title", "shared")).toContain(news?.id);
    const seen = await library.get(b, news?.id ?? "");
    expect(seen?.dataShape?.lists[0]?.path).toBe("news.articles");
    expect(JSON.stringify(seen)).not.toContain("headline");

    const again = await syncPreviews({ pool, tenantId: a, library, index, shapes });
    expect(again.shaped).toEqual([]);
  });
});
