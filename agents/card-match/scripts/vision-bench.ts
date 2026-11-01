// pnpm card-match:vision [--frames a,b] — does frame.look find what is wrong, and does the score?
//
// Takes a frame the agent has already improved, breaks it in a known way in a known place, and asks
// two things of the broken frame: did the pixel match drop by enough to notice, and did the vision
// model name a difference at the place the defect is? The second is the point. A defect the score
// misses and the vision model finds is something the agent could not see before.
//
// Also feeds the vision model two identical pictures, to count differences it invents.
//
// Calls a real vision model: needs AWS credentials like `pnpm eval`, and costs a little per tile.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeImage } from "@dugout/core";
import { FRAMES, HOLDOUT } from "../evals/frames.ts";
import { createControlPlane } from "../src/control-plane.ts";
import {
  type Built,
  type Bundle,
  firstPass,
  loadBundle,
  measureFrame,
  noOverrides,
  type Rect,
  visibleBox,
} from "../src/frame.ts";
import {
  composeDesign,
  LOOK_PROMPT,
  look,
  parseDifferences,
  scaleFor,
  sideBySide,
  tilesOf,
  toFrameBox,
} from "../src/look.ts";
import { loadToolchain } from "../src/toolchain.ts";

try {
  process.loadEnvFile(join(import.meta.dirname, "..", "..", "..", ".env"));
} catch {
  // credentials may come from the environment instead
}

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const WANTED = (
  arg("frames") ?? "fixtures-strip,latest-news,match-centre,ho-tickets,ho-merchandise"
).split(",");
/** A drop in the match this big is one a person reading the number would notice. */
const SCORE_NOTICES = 0.5;
/** A transparent pixel, to take a picture out without breaking the tree. */
const NOTHING =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type DefectKind =
  | "missing picture"
  | "shrunk picture"
  | "wrong words"
  | "missing background"
  | "wrong text colour";
interface Defect {
  kind: DefectKind;
  target: string;
  /** Where it is, in frame pixels. */
  box: Rect;
  apply(nodes: Built["tree"]["nodes"]): void;
}

const area = (r: Rect) => r.w * r.h;

/** The breakable things in a built frame, biggest first, each with its place from the IR. */
function defectsFor(bundle: Bundle, built: Built): Defect[] {
  const root = bundle.doc.root.geometry.bbox;
  const frameArea = root.w * root.h;
  const placed = (src: string): Rect | undefined => {
    const box = visibleBox(bundle, src);
    return box ? { x: box.x - root.x, y: box.y - root.y, w: box.w, h: box.h } : undefined;
  };
  const by = (type: string, ok: (n: Built["tree"]["nodes"][number], box: Rect) => boolean) =>
    built.tree.nodes
      .map((n) => ({ n, box: placed(n.src) }))
      .filter(
        (x): x is { n: Built["tree"]["nodes"][number]; box: Rect } =>
          x.n.type === type && !!x.box && ok(x.n, x.box),
      )
      .sort((a, b) => area(b.box) - area(a.box))[0];

  const out: Defect[] = [];
  const picture = by(
    "Image",
    (_n, box) => area(box) >= frameArea * 0.01 && area(box) < frameArea * 0.6,
  );
  if (picture) {
    out.push({
      kind: "missing picture",
      target: picture.n.src,
      box: picture.box,
      apply: (nodes) => {
        const n = nodes.find((x) => x.id === picture.n.id);
        if (n) n.props = { ...n.props, src: NOTHING };
      },
    });
    out.push({
      kind: "shrunk picture",
      target: picture.n.src,
      box: picture.box,
      apply: (nodes) => {
        const n = nodes.find((x) => x.id === picture.n.id);
        if (n) {
          n.props = {
            ...n.props,
            size: {
              w: { raw: Math.round(picture.box.w * 0.45), _unbound: true },
              h: { raw: Math.round(picture.box.h * 0.45), _unbound: true },
            },
          };
        }
      },
    });
  }
  const text = by(
    "Text",
    (n, box) => String(n.props.content ?? "").length >= 8 && area(box) >= 600,
  );
  if (text) {
    out.push({
      kind: "wrong words",
      target: text.n.src,
      box: text.box,
      apply: (nodes) => {
        const n = nodes.find((x) => x.id === text.n.id);
        if (n) n.props = { ...n.props, content: "LOREM IPSUM DOLOR" };
      },
    });
    const green = tokenNear(bundle, "#00ff00");
    if (green) {
      out.push({
        kind: "wrong text colour",
        target: text.n.src,
        box: text.box,
        apply: (nodes) => {
          const n = nodes.find((x) => x.id === text.n.id);
          if (n) n.props = { ...n.props, tone: green };
        },
      });
    }
  }
  const background =
    by(
      "Stack",
      (n, box) =>
        n.props.surface !== undefined &&
        area(box) >= frameArea * 0.06 &&
        area(box) < frameArea * 0.7,
    ) ??
    by(
      "Box",
      (n, box) =>
        n.props.surface !== undefined &&
        area(box) >= frameArea * 0.06 &&
        area(box) < frameArea * 0.7,
    ) ??
    by(
      "Overlay",
      (n, box) =>
        n.props.surface !== undefined &&
        area(box) >= frameArea * 0.06 &&
        area(box) < frameArea * 0.7,
    );
  if (background) {
    out.push({
      kind: "missing background",
      target: background.n.src,
      box: background.box,
      apply: (nodes) => {
        const n = nodes.find((x) => x.id === background.n.id);
        if (n) {
          const { surface: _drop, ...rest } = n.props;
          n.props = rest;
        }
      },
    });
  }
  return out;
}

function tokenNear(bundle: Bundle, hex: string): string | undefined {
  const body = Object.values(
    (bundle.themeRaw as { tokens: Record<string, { color?: { light?: Record<string, unknown> } }> })
      .tokens,
  )[0];
  const want = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  let best: { ref: string; d: number } | undefined;
  for (const [name, value] of Object.entries(body?.color?.light ?? {})) {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}/i.test(value)) continue;
    const got = [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
    const d = got.reduce((s, v, i) => s + (v - (want[i] ?? 0)) ** 2, 0);
    if (!best || d < best.d) best = { ref: `color.${name}`, d };
  }
  return best?.ref;
}

/**
 * Is a reported difference AT a defect, and not merely somewhere a big box happens to reach it?
 * Overlap has to be real (a tenth of their union), or the difference's centre has to be inside the
 * defect while the difference is no more than six times its size.
 */
function isAt(d: Rect, defect: Rect): boolean {
  const x = Math.max(d.x, defect.x);
  const y = Math.max(d.y, defect.y);
  const w = Math.min(d.x + d.w, defect.x + defect.w) - x;
  const h = Math.min(d.y + d.h, defect.y + defect.h) - y;
  if (w <= 0 || h <= 0) return false;
  const inter = w * h;
  if (inter / (area(d) + area(defect) - inter) >= 0.1) return true;
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  const inside =
    cx >= defect.x && cx <= defect.x + defect.w && cy >= defect.y && cy <= defect.y + defect.h;
  return inside && area(d) <= 6 * area(defect);
}

/** What the model may call the defect and still be describing it. */
const KINDS: Record<DefectKind, string[]> = {
  "missing picture": ["missing", "misplaced", "clipped", "extra", "overlap", "other"],
  "shrunk picture": ["missing", "misplaced", "clipped", "extra", "overlap", "other"],
  "wrong words": ["text", "misplaced", "other"],
  "wrong text colour": ["colour", "text", "other"],
  "missing background": ["missing", "colour", "other", "clipped"],
};

const tools = await loadToolchain();
const plane = createControlPlane("default");
const see = (png: Buffer, prompt: string, signal?: AbortSignal) =>
  describeImage({ png, prompt, model: "sonnet", ...(signal ? { signal } : {}) });
let visionCalls = 0;
const counted: typeof see = (png, prompt, signal) => {
  visionCalls += 1;
  return see(png, prompt, signal);
};

interface Reported {
  where: Rect;
  kind: string;
  severity: string;
  what: string;
}
interface Row {
  frame: string;
  defect: DefectKind;
  target: string;
  box: Rect;
  scoreDrop: number;
  scoreNoticed: boolean;
  differences: Reported[];
  /** The clean frame, looked at the same way: what the model says with nothing broken. */
  clean: Reported[];
}
const rows: Row[] = [];
const controls: Array<{ frame: string; tiles: number; reported: Reported[] }> = [];
const keep = (d: Reported): Reported => ({
  where: d.where,
  kind: d.kind,
  severity: d.severity,
  what: d.what.slice(0, 120),
});

/** A defect is DETECTED when the broken frame has a difference at it that the clean frame lacks. */
function verdict(r: Row, severe = false) {
  const at = (list: Reported[]) =>
    list.some(
      (d) =>
        isAt(d.where, r.box) &&
        KINDS[r.defect].includes(d.kind) &&
        (!severe || d.severity !== "low"),
    );
  const free = at(r.clean);
  return { detected: at(r.differences) && !free, free };
}

for (const frame of [...FRAMES, ...HOLDOUT]) {
  if (!WANTED.includes(frame.id)) continue;
  const bundle = await loadBundle(tools, plane, frame.exportId);
  const first = await firstPass(tools, bundle, noOverrides());
  const base = first.measurement.match;
  console.log(`\n${frame.id}: first pass ${base}%`);
  const clean = (await look({ tools, bundle, built: first.built, see: counted })).differences;

  for (const defect of defectsFor(bundle, first.built)) {
    const nodes = structuredClone(first.built.tree.nodes);
    defect.apply(nodes);
    const broken: Built = { ...first.built, tree: { ...first.built.tree, nodes } };
    const after = (await measureFrame(tools, bundle, broken)).match;
    const looked = await look({ tools, bundle, built: broken, see: counted });
    rows.push({
      frame: frame.id,
      defect: defect.kind,
      target: defect.target,
      box: defect.box,
      scoreDrop: Math.round((base - after) * 100) / 100,
      scoreNoticed: base - after >= SCORE_NOTICES,
      differences: looked.differences.map(keep),
      clean: clean.map(keep),
    });
    const r = rows.at(-1) as Row;
    const v = verdict(r);
    console.log(
      `  ${defect.kind.padEnd(19)} score ${String(-r.scoreDrop).padStart(6)}pt ${r.scoreNoticed ? "noticed " : "missed  "} vision ${v.detected ? "DETECTED" : v.free ? "free    " : "missed  "} (${r.differences.length} reported, ${r.clean.length} on the clean frame)`,
    );
  }

  // two identical pictures: anything reported is invented
  const frameSize = { w: bundle.doc.root.geometry.bbox.w, h: bundle.doc.root.geometry.bbox.h };
  const tiles = tilesOf(frameSize);
  const scale = scaleFor(tiles[0] ?? { w: 400 });
  const design = composeDesign(tools, bundle, scale);
  const invented: Reported[] = [];
  for (const tile of tiles.slice(0, 2)) {
    const w = Math.round(tile.w * scale);
    const h = Math.round(tile.h * scale);
    const cut = tools.png.create(w, h);
    for (let y = 0; y < h; y++) {
      const from =
        ((Math.round(tile.y * scale) + y) * design.width + Math.round(tile.x * scale)) * 4;
      design.data.copy(cut.data, y * w * 4, from, from + w * 4);
    }
    const reply = await counted(tools.png.write(sideBySide(tools, cut, cut)), LOOK_PROMPT);
    for (const d of parseDifferences(reply)) {
      invented.push(
        keep({ where: toFrameBox(d.box, tile), kind: d.kind, severity: d.severity, what: d.what }),
      );
    }
  }
  controls.push({ frame: frame.id, tiles: Math.min(2, tiles.length), reported: invented });
  console.log(
    `  control (identical pictures, ${Math.min(2, tiles.length)} tiles): ${invented.length} differences invented`,
  );
}
await tools.closeBrowser();

const by = new Map<DefectKind, Row[]>();
for (const r of rows) by.set(r.defect, [...(by.get(r.defect) ?? []), r]);
const pct = (n: number, d: number) =>
  d === 0 ? "  - " : `${String(Math.round((100 * n) / d)).padStart(3)}%`;
const line = (name: string, list: Row[]) => {
  const detected = list.filter((r) => verdict(r).detected);
  const severe = list.filter((r) => verdict(r, true).detected);
  const free = list.filter((r) => verdict(r).free);
  const missedByScore = list.filter((r) => !r.scoreNoticed);
  const both = missedByScore.filter((r) => verdict(r).detected);
  return `${name.padEnd(20)} ${String(list.length).padStart(5)}  ${pct(list.filter((r) => r.scoreNoticed).length, list.length).padStart(10)}  ${pct(detected.length, list.length).padStart(9)}  ${pct(severe.length, list.length).padStart(9)}  ${pct(free.length, list.length).padStart(8)}  ${pct(both.length, missedByScore.length).padStart(5)} (${both.length} of ${missedByScore.length})`;
};
console.log(
  "\nDEFECT               cases  score sees  vision    medium+   already     vision where score missed",
);
console.log("                                        detects   high only  reported");
for (const [kind, list] of by) console.log(line(kind, list));
console.log(line("ALL", rows));
const all = controls.flatMap((c) => c.reported);
console.log(
  `control: ${all.length} differences invented across ${controls.reduce((sum, c) => sum + c.tiles, 0)} identical pairs (${all.filter((d) => d.severity !== "low").length} medium or high)`,
);
console.log(`vision calls ${visionCalls}`);

const dir = join(import.meta.dirname, "..", "..", "..", ".evals");
mkdirSync(dir, { recursive: true });
const file = join(dir, `vision-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    { at: new Date().toISOString(), frames: WANTED, rows, controls, visionCalls },
    null,
    2,
  ),
);
console.log(`written ${file}`);
process.exit(0);
