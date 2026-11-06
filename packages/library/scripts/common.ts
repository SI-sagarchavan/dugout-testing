import { join } from "node:path";
import { REPO_ROOT } from "@dugout/core";
import { createPool } from "@dugout/db";
import {
  createFileCropStore,
  createHashMultimodalEmbeddings,
  createSectionLibrary,
  NEUTRAL_PALETTE,
  type SkeletonPalette,
} from "../src/index.ts";

/** The library, its pictures' directory and the pool, as every library command opens them. */
export function openLibrary() {
  const pool = createPool();
  const library = createSectionLibrary({ pool, embeddings: createHashMultimodalEmbeddings() });
  const cropDir = process.env.LIBRARY_CROPS_DIR ?? join(REPO_ROOT, ".runs", "library");
  return { pool, library, cropDir, crops: createFileCropStore(cropDir) };
}

/** The neutral palette with any colours given as flags (`--accent '#d71920'`). */
export function paletteFrom(values: Partial<Record<keyof SkeletonPalette, string | undefined>>) {
  const palette: SkeletonPalette = { ...NEUTRAL_PALETTE };
  for (const key of Object.keys(palette) as Array<keyof SkeletonPalette>) {
    const v = values[key];
    if (v) palette[key] = v;
  }
  return palette;
}
