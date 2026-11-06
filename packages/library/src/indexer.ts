import type { Captioner } from "./caption.ts";
import { type CropStore, pngSize } from "./crops.ts";
import type { FanosTools } from "./fanos.ts";
import { fit, type Image, render } from "./image.ts";
import { indexNodes } from "./ir.ts";
import { findSections, type Plate, type SkippedSection } from "./sections.ts";
import { skeletonOf } from "./skeleton.ts";
import type { HandoffSource } from "./source.ts";
import type { SectionLibrary, SectionSource } from "./store.ts";
import { summarize } from "./summary.ts";

/** A stored picture's longer side at most: enough to read, and what embedding models take. */
export const CROP_MAX_SIDE = 2048;
/** The longer side a vision model reads well; a caption's picture is shrunk to it. */
export const CAPTION_MAX_SIDE = 1568;
/** Sections of one Handoff cut and captioned at once. */
const CONCURRENCY = 4;

export interface IndexedSection {
  id: string;
  nodeId: string;
  name: string;
  kind: string;
  layout: string;
  level: 0 | 1;
  captioned: boolean;
}

export interface IndexReport {
  handoffId: string;
  rootName: string;
  /** New to the library. */
  added: IndexedSection[];
  /** Already there: one more source, and a caption if it had none. */
  seen: IndexedSection[];
  skipped: SkippedSection[];
  failed: Array<{ nodeId: string; name: string; error: string }>;
}

/**
 * One Handoff into the library: read its IR and pictures by ref, find its sections, and for each
 * one either add a source to the section already there or cut, summarise, caption and add it.
 * The IR is held only for the length of this call.
 */
export async function indexHandoff(opts: {
  tenantId: string;
  handoffId: string;
  source: Pick<HandoffSource, "getExport" | "json" | "bytes">;
  library: SectionLibrary;
  crops: CropStore;
  tools: FanosTools;
  /** Without one, sections are added uncaptioned and captioned when next seen with one. */
  captioner?: Captioner;
  now?: () => Date;
}): Promise<IndexReport> {
  const { tenantId, handoffId, source, library, crops, tools, captioner } = opts;
  const now = opts.now ?? (() => new Date());
  const record = await source.getExport(handoffId);
  const doc = tools.parseIr(await source.json(record.irArtifactId));
  const nodes = indexNodes(doc.root);

  const bytes = new Map<string, Buffer>();
  const plates: Plate[] = [];
  await Promise.all(
    record.plates.map(async (p) => {
      const png = await source.bytes(p.artifactId);
      bytes.set(p.artifactId, png);
      plates.push({ nodeId: p.nodeId, name: p.name, ref: p.artifactId, ...pngSize(png) });
    }),
  );
  // the order the plugin sent them, so the first of two pictures of one layer wins every time
  const order = new Map(record.plates.map((p, i) => [p.artifactId, i]));
  plates.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));

  let layouts: Array<{ src: string; kind: string }> = [];
  const failed: IndexReport["failed"] = [];
  try {
    layouts = tools.detectLayout(doc);
  } catch (err) {
    failed.push({
      nodeId: doc.root.id,
      name: doc.root.name,
      error: `layout detection: ${message(err)}`,
    });
  }
  const { sections, skipped } = findSections(doc, { plates, layouts, sign: tools.sign });

  const decoded = new Map<string, Image>();
  const imageOf = (ref: string) => {
    let image = decoded.get(ref);
    if (!image) {
      const png = bytes.get(ref);
      if (!png) throw new Error(`plate ${ref} was not read`);
      image = tools.png.read(png);
      decoded.set(ref, image);
    }
    return image;
  };
  const describe = async (picture: Image, summary: string, layout: string) => {
    if (!captioner) return undefined;
    const png = tools.png.write(fit(tools.png, picture, CAPTION_MAX_SIDE));
    return captioner.caption({ png, summary, layout });
  };

  const added: IndexedSection[] = [];
  const seen: IndexedSection[] = [];
  await eachAtMost(CONCURRENCY, sections, async (s) => {
    const sighting: SectionSource = {
      handoffId,
      irRef: record.irArtifactId,
      nodeId: s.nodeId,
      fileKey: record.fileKey ?? doc.fileKey ?? null,
      at: record.receivedAt ?? now().toISOString(),
    };
    const report = (id: string, kind: string, captioned: boolean): IndexedSection => ({
      id,
      nodeId: s.nodeId,
      name: s.name,
      kind,
      layout: s.layout,
      level: s.level,
      captioned,
    });
    try {
      const node = nodes.get(s.nodeId)?.node;
      if (!node) throw new Error("the section's layer is not in the IR");
      const known = await library.findBySignature(tenantId, s.signature);
      if (known) {
        let section = await library.addSource(tenantId, known.id, sighting);
        // drawn again each time: it comes from the IR, so the latest drawing code wins
        section = await library.setSkeleton(tenantId, section.id, skeletonOf(node));
        if (!section.caption && captioner && section.cropKey) {
          const picture = tools.png.read(await crops.get(section.cropKey));
          const d = await describe(picture, section.summary, section.layout);
          if (d) section = await library.describe(tenantId, section.id, d);
        }
        seen.push(report(section.id, section.kind, Boolean(section.caption)));
        return;
      }
      const picture = fit(tools.png, render(tools.png, s.crop, imageOf), CROP_MAX_SIDE);
      const png = tools.png.write(picture);
      const summary = summarize(node);
      let description: Awaited<ReturnType<typeof describe>>;
      try {
        description = await describe(picture, summary, s.layout);
      } catch (err) {
        failed.push({ nodeId: s.nodeId, name: s.name, error: `caption: ${message(err)}` });
      }
      const cropKey = await crops.put(tenantId, s.signature, png);
      const { section, created } = await library.add(tenantId, {
        signature: s.signature,
        name: s.name,
        layout: s.layout,
        summary,
        box: s.box,
        cropKey,
        cropWidth: picture.width,
        cropHeight: picture.height,
        crop: png,
        skeleton: skeletonOf(node),
        source: sighting,
        ...(description ?? {}),
      });
      (created ? added : seen).push(report(section.id, section.kind, Boolean(section.caption)));
    } catch (err) {
      failed.push({ nodeId: s.nodeId, name: s.name, error: message(err) });
    }
  });

  const position = new Map(sections.map((s, i) => [s.nodeId, i]));
  const inOrder = (list: IndexedSection[]) =>
    list.sort((a, b) => (position.get(a.nodeId) ?? 0) - (position.get(b.nodeId) ?? 0));
  return {
    handoffId,
    rootName: record.rootName ?? doc.root.name,
    added: inOrder(added),
    seen: inOrder(seen),
    skipped,
    failed,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function eachAtMost<T>(limit: number, items: readonly T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
