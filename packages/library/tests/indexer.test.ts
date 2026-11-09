import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import { createPool } from "@dugout/db";
import type {} from "@dugout/db/vitest-setup"; // types for inject()
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  type Captioner,
  createFileCropStore,
  createHashMultimodalEmbeddings,
  createSectionLibrary,
  type FanosTools,
  type HandoffSource,
  type Image,
  type IrNode,
  indexHandoff,
  type Png,
  pngSize,
} from "../src/index.ts";
import { doc, node, shapeOf } from "./fixtures.ts";

const { PNG } = createRequire(join(REPO_ROOT, "packages/renderer/package.json"))("pngjs") as {
  PNG: {
    new (o: { width: number; height: number }): Image;
    sync: { read(b: Buffer): Image; write(i: Image): Buffer };
  };
};
const png: Png = {
  read: (b) => PNG.sync.read(b),
  write: (i) => PNG.sync.write(i),
  create: (width, height) => new PNG({ width, height }),
};

const pool = createPool(inject("databaseUrl"));
afterAll(() => pool.end());
const library = createSectionLibrary({ pool, embeddings: createHashMultimodalEmbeddings() });

/** A 400×300 page: a header, a band holding a carousel, and a footer, each its own colour. */
function page() {
  const tile = (x: number) =>
    node(
      "FRAME",
      { x, y: 140, w: 100, h: 80 },
      {
        mode: "vertical",
        children: [
          node("IMAGE", { x, y: 140, w: 100, h: 50 }),
          node("TEXT", { x, y: 195, w: 100, h: 20 }),
        ],
      },
    );
  const carousel = node(
    "FRAME",
    { x: 20, y: 130, w: 360, h: 100 },
    {
      id: "2:carousel",
      name: "Fixtures",
      mode: "horizontal",
      children: [tile(20), tile(140), tile(260)],
    },
  );
  const root = node(
    "FRAME",
    { x: 0, y: 0, w: 400, h: 300 },
    {
      id: "1:root",
      name: "Home",
      mode: "vertical",
      children: [
        node(
          "FRAME",
          { x: 0, y: 0, w: 400, h: 100 },
          {
            id: "2:header",
            mode: "horizontal",
            children: [node("TEXT", { x: 10, y: 10, w: 80, h: 20 })],
          },
        ),
        node(
          "FRAME",
          { x: 0, y: 100, w: 400, h: 140 },
          {
            id: "2:band",
            mode: "vertical",
            children: [node("TEXT", { x: 20, y: 105, w: 200, h: 20 }), carousel],
          },
        ),
        node(
          "FRAME",
          { x: 0, y: 240, w: 400, h: 60 },
          {
            id: "2:footer",
            mode: "none",
            children: [
              node("VECTOR", { x: 10, y: 250, w: 200, h: 40 }),
              node("TEXT", { x: 220, y: 260, w: 100, h: 20 }),
            ],
          },
        ),
      ],
    },
  );
  return doc(root);
}

/** The page's picture at 2x: a colour per band, so each cut is a different picture. */
function picture(): Buffer {
  const image = png.create(800, 600);
  for (let y = 0; y < 600; y++) {
    const shade = y < 200 ? [200, 0, 0] : y < 480 ? [0, 200, 0] : [0, 0, 200];
    for (let x = 0; x < 800; x++) {
      const i = (y * 800 + x) * 4;
      image.data[i] = shade[0] ?? 0;
      image.data[i + 1] = (shade[1] ?? 0) + (x % 7);
      image.data[i + 2] = shade[2] ?? 0;
      image.data[i + 3] = 255;
    }
  }
  return png.write(image);
}

const tools: FanosTools = {
  parseIr: (json) => json as ReturnType<typeof page>,
  detectLayout: () => [{ src: "2:carousel", kind: "carousel" }],
  sign: (n: IrNode) => shapeOf(n),
  png,
};

function sourceFor(
  ir = page(),
  plate = picture(),
): Pick<HandoffSource, "getExport" | "json" | "bytes"> {
  return {
    getExport: async (id) => ({
      id,
      fileKey: "file-1",
      rootNodeId: "1:root",
      rootName: "Home",
      irArtifactId: `ir-${id}`,
      receivedAt: "2026-11-06T00:00:00.000Z",
      plates: [{ nodeId: "1:root", name: "Home-1-root.png", artifactId: `plate-${id}` }],
    }),
    json: async () => ir,
    bytes: async () => plate,
  };
}

function captioner(fail = false): Captioner & { calls: number } {
  return {
    model: "scripted",
    calls: 0,
    async caption({ layout, png: picture }) {
      this.calls++;
      if (fail) throw new Error("the model is down");
      expect(pngSize(picture).width).toBeGreaterThan(0);
      return {
        caption: layout === "carousel" ? "A carousel of match cards" : "A band of the page",
        kind: layout === "carousel" ? "fixtures" : "other",
        tags: [layout === "carousel" ? "fixtures carousel" : "page band"],
      };
    },
  };
}

let tenant: string;
let crops: ReturnType<typeof createFileCropStore>;
beforeEach(async () => {
  tenant = `t-${randomUUID().slice(0, 8)}`;
  crops = createFileCropStore(await mkdtemp(join(tmpdir(), "library-crops-")));
});

describe("indexHandoff", () => {
  it("adds each section with its picture, summary and caption", async () => {
    const report = await indexHandoff({
      tenantId: tenant,
      handoffId: "h1",
      source: sourceFor(),
      library,
      crops,
      tools,
      captioner: captioner(),
    });
    expect(report.failed).toEqual([]);
    expect(report.added.map((s) => [s.nodeId, s.level, s.layout, s.captioned])).toEqual([
      ["2:header", 0, "none", true],
      ["2:band", 0, "none", true],
      ["2:carousel", 1, "carousel", true],
      ["2:footer", 0, "none", true],
    ]);

    const carousel = await library.get(tenant, report.added[2]?.id ?? "");
    expect(carousel).toMatchObject({
      kind: "fixtures",
      layout: "carousel",
      caption: "A carousel of match cards",
      tags: ["fixtures carousel"],
      cropWidth: 720,
      cropHeight: 200,
      sources: [{ handoffId: "h1", irRef: "ir-h1", nodeId: "2:carousel", fileKey: "file-1" }],
    });
    expect(carousel?.summary).toContain("row 'Fixtures' [3× column [image, text]]");
    expect(pngSize(await crops.get(carousel?.cropKey ?? ""))).toEqual({ width: 720, height: 200 });

    const [top] = await library.search(tenant, { text: "fixtures carousel" });
    expect(top?.id).toBe(carousel?.id);
  });

  it("adds nothing when the same Handoff is indexed again, and a source for another", async () => {
    const first = captioner();
    await indexHandoff({
      tenantId: tenant,
      handoffId: "h1",
      source: sourceFor(),
      library,
      crops,
      tools,
      captioner: first,
    });
    const again = await indexHandoff({
      tenantId: tenant,
      handoffId: "h1",
      source: sourceFor(),
      library,
      crops,
      tools,
      captioner: first,
    });
    expect(again.added).toEqual([]);
    expect(again.seen).toHaveLength(4);
    expect(first.calls).toBe(4);

    const other = await indexHandoff({
      tenantId: tenant,
      handoffId: "h2",
      source: sourceFor(),
      library,
      crops,
      tools,
      captioner: first,
    });
    expect(other.added).toEqual([]);
    const header = await library.get(tenant, other.seen[0]?.id ?? "");
    expect(header?.sources.map((s) => s.handoffId)).toEqual(["h1", "h2"]);
    expect(first.calls).toBe(4);
  });

  it("adds a section when its caption fails, and captions it the next time it is seen", async () => {
    const down = await indexHandoff({
      tenantId: tenant,
      handoffId: "h1",
      source: sourceFor(),
      library,
      crops,
      tools,
      captioner: captioner(true),
    });
    expect(down.added.map((s) => s.captioned)).toEqual([false, false, false, false]);
    expect(down.failed.map((f) => f.error)).toEqual(Array(4).fill("caption: the model is down"));

    const up = await indexHandoff({
      tenantId: tenant,
      handoffId: "h2",
      source: sourceFor(),
      library,
      crops,
      tools,
      captioner: captioner(),
    });
    expect(up.seen.map((s) => s.captioned)).toEqual([true, true, true, true]);
    expect(up.failed).toEqual([]);
  });

  it("indexes without a captioner, by structure alone", async () => {
    const report = await indexHandoff({
      tenantId: tenant,
      handoffId: "h1",
      source: sourceFor(),
      library,
      crops,
      tools,
    });
    expect(report.added.map((s) => s.captioned)).toEqual([false, false, false, false]);
    // the structural summary is searched: only the carousel's names "Fixtures"
    const [top] = await library.search(tenant, { text: "fixtures" });
    expect(top?.id).toBe(report.added.find((s) => s.nodeId === "2:carousel")?.id);
  });
});
