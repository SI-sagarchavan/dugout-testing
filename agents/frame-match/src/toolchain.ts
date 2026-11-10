import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";
import type { LayoutChoice, LayoutIntent, PlatformRead } from "./layout.ts";

/** How deep a section is signed: the section library's `SECTION_SIGNATURE_DEPTH`, kept alike. */
export const SECTION_SIGNATURE_DEPTH = 64;
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreeNode {
  id: string;
  parent: string | null;
  idx: number;
  type: string;
  src: string;
  props: Record<string, unknown>;
}

export interface Tree {
  schemaVersion: string;
  nodes: TreeNode[];
}

export interface IrNode {
  id: string;
  name: string;
  type: string;
  geometry: {
    bbox: { x: number; y: number; w: number; h: number };
    /** Where the layer's pixels are, shadows and strokes included (IR 1.9.0+). */
    renderBbox?: { x: number; y: number; w: number; h: number };
    rotation?: number;
  };
  /** The layer is a mask: it clips the siblings after it (IR 1.9.0+). */
  isMask?: boolean;
  fill?: unknown;
  stroke?: unknown;
  radius?: unknown;
  effects?: unknown;
  opacity?: unknown;
  clipsContent?: boolean;
  layout?: unknown;
  text?: unknown;
  /** The layer is painted with a bitmap. */
  image?: { hasImageFill?: boolean };
  children?: IrNode[];
}

/** A choice a tree writes to its page: `_page.<key>`, one of `options`, starting at `initial`. */
export interface PageChoice {
  key: string;
  options: Array<{ value: string; label?: string }>;
  initial: string;
}

export interface IrDoc {
  rootNodeId: string;
  root: IrNode;
  /** The designer's notes (IR 1.11.0+): see notes.ts. */
  annotations?: unknown[];
}

export interface CompileNote {
  kind: string;
  irId?: string;
  nodeId?: string;
  message: string;
}

export interface Compiled {
  tree: Tree;
  notes: CompileNote[];
  requiredSurfaces: Array<{ name: string; spec: unknown }>;
  requiredAssets: Array<{ name: string; ref: string }>;
}

export interface Issue {
  code: string;
  severity: string;
  message: string;
  nodeId?: string;
}

export interface Conformed {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  summary: { geometry: { totalDelta: number; worstDelta: number; compared: number } };
}

export interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface Toolchain {
  parseIr(json: unknown): IrDoc;
  /**
   * A section's structural signature (ADR 0033): the IR root's, as the section library signs one, so
   * a decision a person makes on it is about the library's row for it.
   */
  sign?(root: IrNode): string;
  parseTheme(json: unknown): unknown;
  parseSurfaces(json: unknown): unknown;
  compile(doc: IrDoc, options: { theme: unknown; icons?: Record<string, string> }): Compiled;
  conform(
    tree: Tree,
    doc: IrDoc,
    options: { theme: unknown; boxes: Box[]; rootSrc: string },
  ): Conformed;
  validate(tree: Tree, theme: unknown, surfaces: unknown): { errors: Issue[]; warnings: Issue[] };
  /** What each container of the frame is: a carousel, a list, tabs (`@fanos/compile`). */
  detectLayout(doc: IrDoc): LayoutIntent[];
  /** The page choices a tree writes: its tabs' keys and options (`@fanos/dsl` `pageChoices`). */
  pageChoices(tree: Tree): PageChoice[];
  /** A platform carousel config read into Carousel props (`@fanos/dsl` `fromPlatformCarousel`). */
  fromPlatformCarousel(json: unknown, options: { colors?: ReadonlySet<string> }): PlatformRead;
  /** Decided layouts applied to the compiled tree. */
  lowerLayout(
    tree: Tree,
    doc: IrDoc,
    choices: LayoutChoice[],
  ): { tree: Tree; notes: Array<{ src: string; message: string }>; lowered: string[] };
  themeCss(theme: unknown, surfaces: unknown): string;
  fontCss: string;
  publicDir: string;
  iconNames: string[];
  renderToPng(tree: Tree, options: Record<string, unknown>): Promise<Buffer>;
  measureNodeBoxes(tree: Tree, options: Record<string, unknown>): Promise<Box[]>;
  diff(
    actual: Buffer,
    expected: Buffer,
    threshold?: number,
  ): { diffPng: Buffer; mismatchCount: number; width: number; height: number };
  closeBrowser(): Promise<void>;
  png: {
    read(bytes: Buffer): PngImage;
    write(image: PngImage): Buffer;
    create(width: number, height: number): PngImage;
  };
}

let loading: Promise<Toolchain> | undefined;

/** The built @fanos packages, the same compiler and renderer a pipeline run uses. `pnpm build`. */
export function loadToolchain(): Promise<Toolchain> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

async function load(): Promise<Toolchain> {
  const root = REPO_ROOT;
  const from = async <T>(path: string) =>
    (await import(pathToFileURL(join(root, "packages", path)).href)) as T;
  const compiler =
    await from<Pick<Toolchain, "compile" | "detectLayout" | "lowerLayout">>(
      "compile/dist/index.js",
    );
  const conformer = await from<{ conform: Toolchain["conform"] }>("conform/dist/index.js");
  const ir = await from<{
    parseFrameIRDocument(json: unknown): IrDoc;
    computeStructuralSignature(node: unknown, depthLimit?: number): string;
  }>("surface-canvas/dist/ir/index.js");
  const dsl = await from<{
    flatTreeSchema: { parse(tree: unknown): unknown };
    validate(tree: unknown, options: { registry: unknown }): { errors: Issue[]; warnings: Issue[] };
    fromPlatformCarousel: Toolchain["fromPlatformCarousel"];
    pageChoices(tree: unknown): Array<PageChoice & { options: Array<{ node?: string }> }>;
  }>("dsl/dist/index.js");
  const tokens = await from<{
    parseThemeJson(json: unknown): unknown[];
    parseSurfaceFile(json: unknown): unknown;
    createRegistry(theme: unknown, options: { surfaces: unknown }): unknown;
    emitCss(theme: unknown, options: { surfaces: unknown; assets: unknown }): { css: string };
    LOCAL_ASSET_CONTEXT: unknown;
  }>("tokens/dist/index.js");
  const renderer = await from<{ FONT_FACE_CSS?: string; ICON_REGISTRY?: Record<string, unknown> }>(
    "renderer/dist/index.js",
  );
  const harness = await from<
    Pick<Toolchain, "renderToPng" | "measureNodeBoxes" | "diff" | "closeBrowser">
  >("renderer/dist/harness.js");
  const { PNG } = createRequire(join(root, "packages/renderer/package.json"))("pngjs") as {
    PNG: {
      new (options: { width: number; height: number }): PngImage;
      sync: { read(bytes: Buffer): PngImage; write(image: PngImage): Buffer };
    };
  };
  // The harness opens its browser on first use and keeps one. Two first calls at once each open
  // one and the first is lost, which keeps the process alive. One render at a time is also all a
  // single browser does.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
    return (...args: A): Promise<R> => {
      const next = turn.then(
        () => fn(...args),
        () => fn(...args),
      );
      turn = next.catch(() => undefined);
      return next;
    };
  };
  return {
    parseIr: (json) => ir.parseFrameIRDocument(json),
    sign: (root) => ir.computeStructuralSignature(root, SECTION_SIGNATURE_DEPTH),
    parseTheme: (json) => {
      const [theme] = tokens.parseThemeJson(json);
      if (!theme) throw new Error("the token set holds no themes");
      return theme;
    },
    parseSurfaces: (json) => tokens.parseSurfaceFile(json),
    compile: compiler.compile,
    detectLayout: compiler.detectLayout,
    lowerLayout: compiler.lowerLayout,
    fromPlatformCarousel: dsl.fromPlatformCarousel,
    // what is stored and shown: each option's value and label, not the node it is drawn as
    pageChoices: (tree) =>
      dsl.pageChoices(tree).map((c) => ({
        key: c.key,
        initial: c.initial,
        options: c.options.map((o) => ({ value: o.value, ...(o.label ? { label: o.label } : {}) })),
      })),
    conform: conformer.conform,
    validate: (tree, theme, surfaces) =>
      dsl.validate(dsl.flatTreeSchema.parse(tree), {
        registry: tokens.createRegistry(theme, { surfaces }),
      }),
    themeCss: (theme, surfaces) =>
      tokens.emitCss(theme, { surfaces, assets: tokens.LOCAL_ASSET_CONTEXT }).css,
    fontCss: renderer.FONT_FACE_CSS ?? "",
    publicDir: join(root, "packages/renderer/public"),
    iconNames: Object.keys(renderer.ICON_REGISTRY ?? {}),
    renderToPng: inTurn(harness.renderToPng),
    measureNodeBoxes: inTurn(harness.measureNodeBoxes),
    diff: harness.diff,
    closeBrowser: inTurn(harness.closeBrowser),
    png: {
      read: (bytes) => PNG.sync.read(bytes),
      write: (image) => PNG.sync.write(image),
      create: (width, height) => new PNG({ width, height }),
    },
  };
}
