/**
 * Looking at an element as the person sees it. The section is drawn here, in the worker, the way
 * frame-match draws a frame: the tree with the binding plan over it, the theme and surfaces the
 * preview names, and its data, through `@fanos/renderer`'s pixel harness (a headless browser on a
 * page of its own; no web app is needed). The element is cut out with some room around it and a
 * vision model asked about it. The picture never enters the agent's transcript: the model that
 * reads it answers in words (`describeImage`), as frame-match's frame.look does.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describeImage, REPO_ROOT } from "@dugout/core";
import type { Tree } from "./dsl.ts";

/** What a section is drawn from: the artifacts its preview link names, read. */
export interface Scene {
  tree: Tree;
  /** The token set (`theme=` on the link). */
  theme: unknown;
  /** The surface set (`surfaces=`), when there is one. */
  surfaces?: unknown;
  /** The data the plan reads (`data=`), when there is any. */
  data?: unknown;
  /** The width the section is drawn at. */
  width: number;
}

/** One element of a section, as a picture: the element and what is around it. */
export type Shoot = (scene: Scene, nodeId: string, signal?: AbortSignal) => Promise<Buffer>;
/** One picture, one question, one answer in words. */
export type See = (png: Buffer, prompt: string, signal?: AbortSignal) => Promise<string>;

/** Room kept around the element, in CSS px: a comment is often about its neighbours too. */
const ROOM = 48;
/** The grey the section is drawn on, as frame-match draws it. */
const PAGE = "#808080";

interface Image {
  width: number;
  height: number;
  data: Buffer;
}
interface Harness {
  renderToPng(tree: Tree, options: Record<string, unknown>): Promise<Buffer>;
  measureNodeBoxes(
    tree: Tree,
    options: Record<string, unknown>,
  ): Promise<Array<{ id: string; x: number; y: number; w: number; h: number }>>;
  themeCss(theme: unknown, surfaces: unknown): string;
  fontCss: string;
  publicDir: string;
  png: {
    read(bytes: Buffer): Image;
    write(image: Image): Buffer;
    create(w: number, h: number): Image;
  };
}

let loading: Promise<Harness> | undefined;

/** The built @fanos packages: the tokens' CSS and the renderer's harness (`pnpm build`). */
function harness(): Promise<Harness> {
  loading ??= (async (): Promise<Harness> => {
    const from = async <T>(path: string) =>
      (await import(pathToFileURL(join(REPO_ROOT, "packages", path)).href)) as T;
    const tokens = await from<{
      parseThemeJson(json: unknown): unknown[];
      parseSurfaceFile(json: unknown): unknown;
      emitCss(theme: unknown, options: { surfaces: unknown; assets: unknown }): { css: string };
      LOCAL_ASSET_CONTEXT: unknown;
    }>("tokens/dist/index.js");
    const renderer = await from<{ FONT_FACE_CSS?: string }>("renderer/dist/index.js");
    const pixels = await from<Pick<Harness, "renderToPng" | "measureNodeBoxes">>(
      "renderer/dist/harness.js",
    );
    const { PNG } = createRequire(join(REPO_ROOT, "packages/renderer/package.json"))("pngjs") as {
      PNG: {
        new (options: { width: number; height: number }): Image;
        sync: { read(bytes: Buffer): Image; write(image: Image): Buffer };
      };
    };
    // one render at a time: the harness keeps one browser, and two first calls would open two
    let turn: Promise<unknown> = Promise.resolve();
    const inTurn =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        const next = turn.then(
          () => fn(...args),
          () => fn(...args),
        );
        turn = next.catch(() => undefined);
        return next;
      };
    return {
      renderToPng: inTurn(pixels.renderToPng),
      measureNodeBoxes: inTurn(pixels.measureNodeBoxes),
      themeCss: (theme, surfaces) => {
        const [parsed] = tokens.parseThemeJson(theme);
        if (!parsed) throw new Error("the preview's token set holds no theme");
        return tokens.emitCss(parsed, {
          surfaces: surfaces ? tokens.parseSurfaceFile(surfaces) : undefined,
          assets: tokens.LOCAL_ASSET_CONTEXT,
        }).css;
      },
      fontCss: renderer.FONT_FACE_CSS ?? "",
      publicDir: join(REPO_ROOT, "packages/renderer/public"),
      png: {
        read: (bytes) => PNG.sync.read(bytes),
        write: (image) => PNG.sync.write(image),
        create: (w, h) => new PNG({ width: w, height: h }),
      },
    };
  })().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

/** The part of `image` inside the box, kept within the picture. */
function crop(tools: Harness, image: Image, box: { x: number; y: number; w: number; h: number }) {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.max(1, Math.min(image.width - x, Math.ceil(box.w)));
  const h = Math.max(1, Math.min(image.height - y, Math.ceil(box.h)));
  const out = tools.png.create(w, h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * image.width + x) * 4;
    image.data.copy(out.data, row * w * 4, from, from + w * 4);
  }
  return tools.png.write(out);
}

export const shootSection: Shoot = async (scene, nodeId) => {
  const tools = await harness();
  const options = {
    themeCss: tools.themeCss(scene.theme, scene.surfaces),
    fontCss: tools.fontCss,
    publicDir: tools.publicDir,
    width: scene.width,
    background: PAGE,
    deviceScaleFactor: 1,
    ...(scene.data ? { data: scene.data } : {}),
  };
  const [png, boxes] = await Promise.all([
    tools.renderToPng(scene.tree, options),
    tools.measureNodeBoxes(scene.tree, options),
  ]);
  const box = boxes.find((b) => b.id === nodeId);
  if (!box || box.w < 1 || box.h < 1) {
    throw new Error(`element ${nodeId} is not drawn on the section (hidden, or no size)`);
  }
  return crop(tools, tools.png.read(png), {
    x: box.x - ROOM,
    y: box.y - ROOM,
    w: box.w + 2 * ROOM + Math.min(0, box.x - ROOM),
    h: box.h + 2 * ROOM + Math.min(0, box.y - ROOM),
  });
};

export const seeWithHaiku: See = (png, prompt, signal) =>
  describeImage({ png, prompt, model: "haiku", ...(signal ? { signal } : {}) });

/** What the vision model is asked: the comment's question about the element in the middle. */
export function lookPrompt(nodeId: string, type: string, question: string): string {
  return [
    `This is part of a web page. The element in the middle (${type} "${nodeId}", with up to ${ROOM}px of the page around it, on a grey background) is what a person commented on.`,
    `Answer about it, plainly and briefly: ${question}`,
    "Say what you see (colours, borders, spacing, alignment, sizes relative to what is around it, text and how it wraps), not what the element should be. If the answer is not visible, say so.",
  ].join("\n");
}
