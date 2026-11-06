import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@dugout/core";
import type { Png } from "./image.ts";
import type { IrDoc, IrNode } from "./ir.ts";
import type { LayoutHint } from "./sections.ts";

/**
 * Deep enough to fold in a whole section: the IR's strict signature, over every level and not the
 * plugin's three, so two sections are one only when they are the same shape all the way down.
 */
export const SECTION_SIGNATURE_DEPTH = 64;

/** What indexing needs from the built `@fanos` packages. */
export interface FanosTools {
  parseIr(json: unknown): IrDoc;
  detectLayout(doc: IrDoc): LayoutHint[];
  sign(node: IrNode): string;
  png: Png;
}

let loading: Promise<FanosTools> | undefined;

/**
 * The IR parser, layout detection and signature the plugin and frame-match use, from the built
 * `@fanos` packages (`pnpm build`), and pngjs from the renderer.
 */
export function loadFanosTools(): Promise<FanosTools> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

async function load(): Promise<FanosTools> {
  const from = async <T>(path: string) => {
    try {
      return (await import(pathToFileURL(join(REPO_ROOT, "packages", path)).href)) as T;
    } catch (err) {
      throw new Error(
        `cannot load packages/${path} (run \`pnpm build\`): ${(err as Error).message}`,
      );
    }
  };
  const ir = await from<{
    parseFrameIRDocument(json: unknown): IrDoc;
    computeStructuralSignature(node: unknown, depthLimit?: number): string;
  }>("surface-canvas/dist/ir/index.js");
  const compiler = await from<{
    detectLayout(doc: IrDoc): Array<{ src: string; kind: string }>;
  }>("compile/dist/index.js");
  const { PNG } = createRequire(join(REPO_ROOT, "packages/renderer/package.json"))("pngjs") as {
    PNG: {
      new (options: {
        width: number;
        height: number;
      }): { width: number; height: number; data: Buffer };
      sync: {
        read(bytes: Buffer): { width: number; height: number; data: Buffer };
        write(image: { width: number; height: number; data: Buffer }): Buffer;
      };
    };
  };
  return {
    parseIr: (json) => ir.parseFrameIRDocument(json),
    detectLayout: (doc) => compiler.detectLayout(doc).map((l) => ({ src: l.src, kind: l.kind })),
    sign: (node) => ir.computeStructuralSignature(node, SECTION_SIGNATURE_DEPTH),
    png: {
      read: (bytes) => PNG.sync.read(bytes),
      write: (image) => PNG.sync.write(image),
      create: (width, height) => new PNG({ width, height }),
    },
  };
}
