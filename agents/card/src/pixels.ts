import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolContext } from "@dugout/contracts";
import { checkCard, trialRoot } from "./dsl.ts";
import type { CardDraft } from "./schema.ts";

/** A mismatch passes when its thinner side is at most this many pixels. */
export const PIXEL_TOLERANCE = 8;

const VIEWPORT = 1440;
const PAGE = "#0a0a0a";
const VIEW_HEIGHT = 4096;
const MAX_REGIONS = 8;
const MAX_NODE_IDS = 4;
const PAINTED = new Set(["Box", "Stack", "Overlay", "Text", "Image", "Icon", "Divider", "Button"]);

export interface PngSize {
  width: number;
  height: number;
}

export interface DiffRegionReport {
  x: number;
  y: number;
  w: number;
  h: number;
  nodeIds: string[];
}

export interface FidelityReport {
  ok: boolean;
  tolerance: typeof PIXEL_TOLERANCE;
  message: string;
  size: { render: PngSize | null; screenshot: PngSize | null };
  regions: DiffRegionReport[];
  mismatchCount?: number;
  issues?: string[];
}

/** The smaller side is the thickness of the mismatch. A hairline along an edge stays within 8. */
export function withinEight(region: { w: number; h: number }): boolean {
  return Math.min(region.w, region.h) <= PIXEL_TOLERANCE;
}

/** PNG width and height from the IHDR chunk. Undefined when the bytes are not a PNG. */
export function pngSize(buf: Buffer): PngSize | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((byte, i) => buf[i] === byte)) return undefined;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export type Reference =
  | { mode: "off" }
  | { mode: "invalid"; reason: string }
  | {
      mode: "prompt";
      cardId: string;
      screenshotPath: string;
      mtimeMs: number;
      size: number;
    }
  | {
      mode: "on";
      cardId: string;
      figmaPath: string;
      screenshotPath: string;
      mtimeMs: number;
      size: number;
    };

/** The host's figma and screenshot paths. The model does not choose them. */
export function referenceOf(input: unknown): Reference {
  const fields = fieldsOf(input);
  if (!fields.figma && !fields.screenshot) return { mode: "off" };
  if (!fields.cardId) return { mode: "invalid", reason: "the run has no cardId" };
  if (fields.figma && !fields.screenshot) {
    return { mode: "invalid", reason: "figma and screenshot are set together" };
  }
  const shot = resolveFile("screenshot", fields.screenshot ?? "", 8_000_000);
  if ("error" in shot) return { mode: "invalid", reason: shot.error };
  if (!fields.figma) {
    return {
      mode: "prompt",
      cardId: fields.cardId,
      screenshotPath: shot.path,
      mtimeMs: shot.mtimeMs,
      size: shot.size,
    };
  }
  const figma = resolveFile("figma", fields.figma, 1_000_000);
  if ("error" in figma) return { mode: "invalid", reason: figma.error };
  return {
    mode: "on",
    cardId: fields.cardId,
    figmaPath: figma.path,
    screenshotPath: shot.path,
    mtimeMs: shot.mtimeMs,
    size: shot.size,
  };
}

/** Denies card.save before approval when this run has a screenshot the tree has not matched. */
export function passBlock(
  draft: CardDraft,
  ctx: Pick<ToolContext, "runId" | "input">,
): string | undefined {
  const ref = referenceOf(ctx.input);
  if (ref.mode === "off" || ref.mode === "prompt") return undefined;
  if (ref.mode === "invalid") return ref.reason;
  if (draft.cardId !== ref.cardId) return `cardId must be ${ref.cardId}`;
  const pass = passes.get(ctx.runId);
  if (
    !pass ||
    pass.key !== draftKey(draft) ||
    pass.screenshot !== ref.screenshotPath ||
    pass.mtimeMs !== ref.mtimeMs ||
    pass.size !== ref.size
  ) {
    return "card.diff has not accepted this tree. Call card.diff, fix every region thicker than 8 pixels, and save that same tree.";
  }
  return undefined;
}

/** The Figma file the host named, as a tree and data the checker can take. */
export function loadFigma(input: unknown): {
  ok: boolean;
  issues?: string[];
  tree?: unknown;
  data?: unknown;
  nodeCount?: number;
  dataMissing?: boolean;
  unsupported?: string[];
} {
  const ref = referenceOf(input);
  if (ref.mode === "off" || ref.mode === "prompt") {
    return { ok: false, issues: ["this run has no Figma DSL"] };
  }
  if (ref.mode === "invalid") return { ok: false, issues: [ref.reason] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ref.figmaPath, "utf8"));
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
  const split = splitFigma(raw);
  if ("error" in split) return { ok: false, issues: [split.error] };
  const nodes = nodesOf(split.tree);
  if (!nodes) return { ok: false, issues: ["the Figma tree has no nodes array"] };
  const unsupported = [
    ...new Set(nodes.map((node) => node.type).filter((type) => !PAINTED.has(type))),
  ];
  return {
    ok: true,
    tree: split.tree,
    data: split.data,
    nodeCount: nodes.length,
    dataMissing: split.dataMissing,
    unsupported,
  };
}

/** Render the draft and compare it to the screenshot. Remembers a pass for this run. */
export async function diffCard(
  draft: CardDraft,
  ctx: Pick<ToolContext, "runId" | "input">,
): Promise<FidelityReport> {
  const ref = referenceOf(ctx.input);
  if (ref.mode === "off") {
    return {
      ok: true,
      tolerance: PIXEL_TOLERANCE,
      message: "this run has no reference screenshot",
      size: { render: null, screenshot: null },
      regions: [],
    };
  }
  if (ref.mode === "prompt") {
    return fail("This run generates from the brief. The screenshot is read by card.see.");
  }
  if (ref.mode === "invalid") return fail(ref.reason);
  if (draft.cardId !== ref.cardId) return fail(`cardId must be ${ref.cardId}`);
  const check = checkCard(draft.tree, draft.data);
  if (!check.ok) {
    return { ...fail(check.issues.join("\n")), issues: check.issues };
  }
  const before = ref.mtimeMs;
  const beforeSize = ref.size;
  const report = await compareCard(draft, ref.screenshotPath);
  const after = statFile(ref.screenshotPath);
  if (!after || after.mtimeMs !== before || after.size !== beforeSize) {
    return fail("the screenshot changed during the compare. Call card.diff again.");
  }
  if (report.ok) {
    rememberPass(ctx.runId, draft, {
      path: ref.screenshotPath,
      mtimeMs: after.mtimeMs,
      size: after.size,
    });
  }
  return report;
}

/** Render at the screenshot's width and report regions thicker than 8 pixels. */
export async function compareCard(
  draft: CardDraft,
  screenshotPath: string,
): Promise<FidelityReport> {
  let expected: Buffer;
  try {
    expected = readFileSync(screenshotPath);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const shot = pngSize(expected);
  if (!shot) return fail("the screenshot is not a PNG");
  let harness: Harness;
  try {
    harness = await loadHarness();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  let actual: Buffer;
  try {
    actual = await harness.renderToPng(draft.tree, renderOptions(harness, shot.width, draft.data));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const rendered = pngSize(actual);
  if (!rendered) return fail("the render is not a PNG");
  const size = { render: rendered, screenshot: shot };
  if (rendered.width !== shot.width || rendered.height !== shot.height) {
    return {
      ok: false,
      tolerance: PIXEL_TOLERANCE,
      message: `the render is ${rendered.width}×${rendered.height} and the screenshot is ${shot.width}×${shot.height}. They have to be the same size. The 8 pixel check runs after that.`,
      size,
      regions: [],
    };
  }
  const result = harness.diff(actual, expected);
  const thick = result.regions.filter((region) => !withinEight(region));
  if (thick.length === 0) {
    return {
      ok: true,
      tolerance: PIXEL_TOLERANCE,
      message: "within 8 pixels",
      size,
      regions: [],
      mismatchCount: result.mismatchCount,
    };
  }
  let boxes: NodeBox[] = [];
  try {
    boxes = await harness.measureNodeBoxes(
      draft.tree,
      renderOptions(harness, shot.width, draft.data),
    );
  } catch {
    boxes = [];
  }
  const mapped = harness
    .mapRegionsToNodes(thick, boxes)
    .slice(0, MAX_REGIONS)
    .map((item) => ({
      x: item.region.x,
      y: item.region.y,
      w: item.region.w,
      h: item.region.h,
      nodeIds: item.nodeIds.slice(0, MAX_NODE_IDS),
    }));
  const extra =
    thick.length > mapped.length
      ? ` Showing ${mapped.length} of ${thick.length}, largest first.`
      : "";
  return {
    ok: false,
    tolerance: PIXEL_TOLERANCE,
    message: `${thick.length} region(s) are more than 8 pixels thick. The first node id is the one to change.${extra}`,
    size,
    regions: mapped,
    mismatchCount: result.mismatchCount,
  };
}

/** One render of the draft, at a fixed width. Tests use it to build a reference PNG. */
export async function renderCardPng(draft: CardDraft, width: number): Promise<Buffer> {
  const harness = await loadHarness();
  return harness.renderToPng(draft.tree, renderOptions(harness, width, draft.data));
}

export async function closeRenderBrowser(): Promise<void> {
  if (!harness) return;
  await harness.closeBrowser();
}

function fail(message: string): FidelityReport {
  return {
    ok: false,
    tolerance: PIXEL_TOLERANCE,
    message,
    size: { render: null, screenshot: null },
    regions: [],
  };
}

function renderOptions(harness: Harness, width: number, data: unknown) {
  return {
    data,
    themeCss: harness.themeCss,
    fontCss: harness.fontCss,
    publicDir: harness.publicDir,
    width,
    viewport: VIEWPORT,
    height: VIEW_HEIGHT,
    background: PAGE,
  };
}

interface FileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

function resolveFile(label: string, raw: string, maxBytes: number): FileStat | { error: string } {
  if (!isAbsolute(raw)) return { error: `${label} must be an absolute path` };
  const stat = statFile(raw);
  if (!stat) return { error: `${label} not found: ${raw}` };
  if (stat.size === 0) return { error: `${label} is empty` };
  if (stat.size > maxBytes) return { error: `${label} is too large` };
  return stat;
}

function statFile(path: string): FileStat | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return { path, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

function fieldsOf(input: unknown): { cardId?: string; figma?: string; screenshot?: string } {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.cardId === "string" ? { cardId: record.cardId } : {}),
    ...(typeof record.figma === "string" ? { figma: record.figma } : {}),
    ...(typeof record.screenshot === "string" ? { screenshot: record.screenshot } : {}),
  };
}

interface Split {
  tree: unknown;
  data: unknown;
  dataMissing: boolean;
}

function splitFigma(raw: unknown): Split | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "the Figma file is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.tree && typeof obj.tree === "object") {
    const dataMissing = !obj.data || typeof obj.data !== "object";
    return { tree: obj.tree, data: dataMissing ? { match: {} } : obj.data, dataMissing };
  }
  if (typeof obj.schemaVersion === "string" && Array.isArray(obj.nodes)) {
    const dataMissing = !obj.data || typeof obj.data !== "object";
    return {
      tree: { schemaVersion: obj.schemaVersion, nodes: obj.nodes },
      data: dataMissing ? { match: {} } : obj.data,
      dataMissing,
    };
  }
  const keys = Object.keys(obj).slice(0, 8).join(", ");
  return { error: `expected schemaVersion and nodes, or tree and data. Keys: ${keys}` };
}

/** Node types the trial renderer does not paint. Button and Icon are painted. */
export function unpaintedTypes(tree: unknown): string[] {
  const nodes = nodesOf(tree);
  if (!nodes) return [];
  return [...new Set(nodes.map((node) => node.type).filter((type) => type && !PAINTED.has(type)))];
}

function nodesOf(tree: unknown): Array<{ id: unknown; type: string; parent: unknown }> | undefined {
  if (!tree || typeof tree !== "object") return undefined;
  const nodes = (tree as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.map((node) => {
    const item = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
    return {
      id: item.id,
      type: typeof item.type === "string" ? item.type : "",
      parent: item.parent,
    };
  });
}

interface Pass {
  key: string;
  screenshot: string;
  mtimeMs: number;
  size: number;
}

const passes = new Map<string, Pass>();

function rememberPass(
  runId: string,
  draft: CardDraft,
  shot: { path: string; mtimeMs: number; size: number },
) {
  if (passes.has(runId)) passes.delete(runId);
  passes.set(runId, {
    key: draftKey(draft),
    screenshot: shot.path,
    mtimeMs: shot.mtimeMs,
    size: shot.size,
  });
  while (passes.size > 100) {
    const oldest = passes.keys().next().value;
    if (oldest === undefined) break;
    passes.delete(oldest);
  }
}

function draftKey(draft: CardDraft): string {
  return JSON.stringify(sortJson(draft));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Harness {
  renderToPng(tree: unknown, options: Record<string, unknown>): Promise<Buffer>;
  measureNodeBoxes(tree: unknown, options: Record<string, unknown>): Promise<NodeBox[]>;
  diff(
    actual: Buffer,
    expected: Buffer,
  ): {
    regions: Array<{ x: number; y: number; w: number; h: number; area: number }>;
    mismatchCount: number;
  };
  mapRegionsToNodes(
    regions: unknown[],
    boxes: NodeBox[],
  ): Array<{ region: { x: number; y: number; w: number; h: number }; nodeIds: string[] }>;
  closeBrowser(): Promise<void>;
  themeCss: string;
  fontCss: string;
  publicDir: string;
}

let harness: Harness | undefined;
let loading: Promise<Harness> | undefined;

async function loadHarness(): Promise<Harness> {
  if (harness) return harness;
  loading ??= loadHarnessOnce().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

async function loadHarnessOnce(): Promise<Harness> {
  const root = trialRoot();
  const renderer = (await import(
    pathToFileURL(join(root, "packages/renderer/dist/harness.js")).href
  )) as Omit<Harness, "themeCss" | "fontCss" | "publicDir">;
  const fonts = (await import(
    pathToFileURL(join(root, "packages/renderer/dist/index.js")).href
  )) as { FONT_FACE_CSS?: string };
  const tokens = (await import(
    pathToFileURL(join(root, "packages/tokens/dist/index.js")).href
  )) as {
    loadTheme(path: string): unknown;
    loadSurfaces(path: string): unknown;
    emitCss(theme: unknown, options: { surfaces: unknown; assets: unknown }): { css: string };
    LOCAL_ASSET_CONTEXT: unknown;
  };
  if (!fonts.FONT_FACE_CSS) throw new Error("the trial renderer did not export FONT_FACE_CSS");
  const theme = tokens.loadTheme(join(root, "packages/tokens/fixtures/southern-brave.json"));
  const surfaces = tokens.loadSurfaces(join(root, "packages/tokens/surfaces/southern-brave.json"));
  const { css } = tokens.emitCss(theme, { surfaces, assets: tokens.LOCAL_ASSET_CONTEXT });
  harness = {
    ...renderer,
    themeCss: css,
    fontCss: fonts.FONT_FACE_CSS,
    publicDir: join(root, "packages/renderer/public"),
  };
  return harness;
}
