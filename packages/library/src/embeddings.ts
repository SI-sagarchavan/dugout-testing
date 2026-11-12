import { createHash } from "node:crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntime } from "@dugout/core";
import { createHashEmbeddings, EMBEDDING_DIMENSIONS } from "@dugout/memory";

/**
 * Words and pictures into one space, so words can find a picture and a picture can find words.
 * Both columns of `library_sections` are 1024 long; a model that cannot give that needs a
 * migration. The model is Amazon Nova Multimodal Embeddings on Bedrock.
 */
export interface MultimodalEmbeddings {
  readonly model: string;
  /** `use`: a section being stored (`index`, the default) or a search's query (`query`). */
  embedText(texts: string[], use?: EmbeddingUse): Promise<number[][]>;
  /** PNG bytes; a query may be a JPEG, GIF or WebP too. */
  embedImages(images: Buffer[], use?: EmbeddingUse): Promise<number[][]>;
}

export type EmbeddingUse = "index" | "query";

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** An image's format from its first bytes, as the model names it; undefined when it is none of them. */
export function sniffImageFormat(bytes: Buffer): ImageFormat | undefined {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

export const NOVA_MULTIMODAL_EMBED = "amazon.nova-2-multimodal-embeddings-v1:0";
/** The longest text the model takes; more is cut from the end. */
const NOVA_TEXT_CHARS = 8_192;

/**
 * Amazon Nova Multimodal Embeddings on Bedrock: words and pictures in one 1024-long space, one
 * input per InvokeModel call. A stored section is embedded as `GENERIC_INDEX` whatever it is; a
 * query as `GENERIC_RETRIEVAL`, because the library holds both words and pictures. Credentials as
 * for the Bedrock chat client. The model is offered in few regions, and not ap-south-1: it is
 * called in `us-east-1` unless `region` or `NOVA_EMBEDDING_REGION` names another.
 */
export const NOVA_EMBEDDING_REGION = "us-east-1";
export function createNovaMultimodalEmbeddings(
  opts: { region?: string; runtime?: BedrockRuntime } = {},
): MultimodalEmbeddings {
  const region = opts.region ?? process.env.NOVA_EMBEDDING_REGION ?? NOVA_EMBEDDING_REGION;
  const runtime: BedrockRuntime = opts.runtime ?? new BedrockRuntimeClient({ region });
  const embed = async (
    use: EmbeddingUse,
    input: { text: Record<string, unknown> } | { image: Record<string, unknown> },
  ) => {
    const res = (await runtime.send(
      new InvokeModelCommand({
        modelId: NOVA_MULTIMODAL_EMBED,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          schemaVersion: "nova-multimodal-embed-v1",
          taskType: "SINGLE_EMBEDDING",
          singleEmbeddingParams: {
            embeddingPurpose: use === "query" ? "GENERIC_RETRIEVAL" : "GENERIC_INDEX",
            embeddingDimension: EMBEDDING_DIMENSIONS,
            ...input,
          },
        }),
      }),
    )) as { body: Uint8Array };
    const { embeddings } = JSON.parse(new TextDecoder().decode(res.body)) as {
      embeddings?: Array<{ embedding?: number[] }>;
    };
    const vector = embeddings?.[0]?.embedding;
    if (vector?.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `${NOVA_MULTIMODAL_EMBED} returned ${vector?.length ?? 0} dimensions, need ${EMBEDDING_DIMENSIONS}`,
      );
    }
    return vector;
  };
  return {
    model: NOVA_MULTIMODAL_EMBED,
    embedText: (texts, use = "index") =>
      Promise.all(
        texts.map((value) =>
          embed(use, {
            text: { truncationMode: "END", value: value.slice(0, NOVA_TEXT_CHARS) },
          }),
        ),
      ),
    embedImages: (images, use = "index") =>
      Promise.all(
        images.map(async (bytes) => {
          const format = sniffImageFormat(bytes);
          if (!format) throw new Error("the picture is not a PNG, JPEG, GIF or WebP");
          return embed(use, {
            image: {
              format,
              detailLevel: "STANDARD_IMAGE",
              source: { bytes: bytes.toString("base64") },
            },
          });
        }),
      ),
  };
}

/**
 * `EMBEDDING_PROVIDER=bedrock` selects Nova Multimodal Embeddings; with it unset, the hash
 * embedder (tests, and a machine with no AWS). Switching means embedding every section again.
 */
export function loadMultimodalEmbeddings(
  env: Record<string, string | undefined> = process.env,
): MultimodalEmbeddings {
  return env.EMBEDDING_PROVIDER === "bedrock"
    ? createNovaMultimodalEmbeddings(
        env.NOVA_EMBEDDING_REGION ? { region: env.NOVA_EMBEDDING_REGION } : {},
      )
    : createHashMultimodalEmbeddings();
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
