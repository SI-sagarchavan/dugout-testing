import { createHash } from "node:crypto";
import OpenAI from "openai";

/** Fixed by the `memory_items.embedding` column; changing it means a migration and re-embedding. */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingClient {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Any OpenAI-compatible `/embeddings` endpoint (OpenAI, Voyage via gateway, Ollama, vLLM...). */
export function createOpenAICompatibleEmbeddings(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
}): EmbeddingClient {
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
  return {
    model: opts.model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await client.embeddings.create({
        model: opts.model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      });
      const vectors = res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      for (const v of vectors) {
        if (v.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `${opts.model} returned ${v.length} dimensions, need ${EMBEDDING_DIMENSIONS}`,
          );
        }
      }
      return vectors;
    },
  };
}

/**
 * Feature hashing of words into a unit vector. No model and no network, so similarity is lexical
 * only. The default until an embedding provider is configured, and what tests use.
 */
export function createHashEmbeddings(): EmbeddingClient {
  return {
    model: "hash-v1",
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const h = createHash("sha256").update(word).digest();
          const bucket = h.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
          v[bucket] = (v[bucket] ?? 0) + ((h[4] ?? 0) & 1 ? 1 : -1);
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

/** EMBEDDING_BASE_URL selects a provider; without it, the hash embedder is used. */
export function loadEmbeddings(env: Record<string, string | undefined> = process.env) {
  if (!env.EMBEDDING_BASE_URL) return createHashEmbeddings();
  if (!env.EMBEDDING_MODEL) throw new Error("EMBEDDING_MODEL is required with EMBEDDING_BASE_URL");
  return createOpenAICompatibleEmbeddings({
    baseURL: env.EMBEDDING_BASE_URL,
    apiKey: env.EMBEDDING_API_KEY || "none",
    model: env.EMBEDDING_MODEL,
  });
}
