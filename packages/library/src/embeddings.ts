import { createHash } from "node:crypto";
import { createHashEmbeddings, EMBEDDING_DIMENSIONS } from "@dugout/memory";

/**
 * Words and pictures into one space, so words can find a picture and a picture can find words.
 * Both columns of `library_sections` are 1024 long; a model that cannot give that needs a
 * migration. Which Bedrock model is ticket 01 of `.scratch/section-library`.
 */
export interface MultimodalEmbeddings {
  readonly model: string;
  embedText(texts: string[]): Promise<number[][]>;
  /** PNG bytes. */
  embedImages(images: Buffer[]): Promise<number[][]>;
}

/**
 * No model and no network: words by feature hashing (as memory's default), pictures by hashing
 * their bytes, so only the same picture is near itself. Words and pictures are not in one space.
 * The default until a model is chosen, and what tests use.
 */
export function createHashMultimodalEmbeddings(): MultimodalEmbeddings {
  const words = createHashEmbeddings();
  return {
    model: "hash-v1",
    embedText: (texts) => words.embed(texts),
    async embedImages(images) {
      return images.map((bytes) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const digest = createHash("sha256").update(bytes).digest();
        for (let i = 0; i + 4 <= digest.length; i += 4) {
          const bucket = digest.readUInt32BE(i) % EMBEDDING_DIMENSIONS;
          v[bucket] = (v[bucket] ?? 0) + 1;
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}
