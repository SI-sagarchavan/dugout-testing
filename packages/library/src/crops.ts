import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Where section pictures are kept, by key. A directory now; the client's S3 bucket later (ticket
 * 12), behind the same two calls. Keys are `<tenant>/<signature>.png`, so a section re-indexed
 * writes over its own picture and nothing else.
 */
export interface CropStore {
  put(tenantId: string, signature: string, png: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const SAFE = /[^a-zA-Z0-9_-]/g;

export function cropKey(tenantId: string, signature: string): string {
  return `${tenantId.replace(SAFE, "_")}/${signature.replace(SAFE, "_")}.png`;
}

export function createFileCropStore(dir: string): CropStore {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(`${root}/`)) throw new Error(`crop key outside the store: ${key}`);
    return path;
  };
  return {
    async put(tenantId, signature, png) {
      const key = cropKey(tenantId, signature);
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, png);
      return key;
    },
    get: (key) => readFile(pathOf(key)),
  };
}

/** A PNG's size from its header, without decoding it. */
export function pngSize(png: Buffer): { width: number; height: number } {
  const signature = png.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("not a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
