import type { BedrockRuntime } from "@dugout/core";
import { describe, expect, it } from "vitest";
import {
  createHashMultimodalEmbeddings,
  createNovaMultimodalEmbeddings,
  loadMultimodalEmbeddings,
  NOVA_MULTIMODAL_EMBED,
  sniffImageFormat,
} from "../src/index.ts";

function fake(dimensions = 1024) {
  // biome-ignore lint/suspicious/noExplicitAny: the request is read field by field
  const sent: Array<{ modelId: string; body: Record<string, any> }> = [];
  const runtime = {
    async send(command: { input: { modelId: string; body: string } }) {
      sent.push({ modelId: command.input.modelId, body: JSON.parse(command.input.body) });
      const body = JSON.stringify({
        embeddings: [{ embeddingType: "TEXT", embedding: new Array(dimensions).fill(0.5) }],
      });
      return { body: new TextEncoder().encode(body) };
    },
  } as unknown as BedrockRuntime;
  return { runtime, sent };
}

describe("Nova Multimodal Embeddings", () => {
  it("embeds a stored section's words as GENERIC_INDEX and a query's as GENERIC_RETRIEVAL", async () => {
    const { runtime, sent } = fake();
    const nova = createNovaMultimodalEmbeddings({ runtime });
    const [v] = await nova.embedText(["hero band"]);
    await nova.embedText(["a hero"], "query");
    expect(v).toHaveLength(1024);
    expect(sent[0]?.modelId).toBe(NOVA_MULTIMODAL_EMBED);
    expect(sent[0]?.body).toMatchObject({
      schemaVersion: "nova-multimodal-embed-v1",
      taskType: "SINGLE_EMBEDDING",
      singleEmbeddingParams: {
        embeddingPurpose: "GENERIC_INDEX",
        embeddingDimension: 1024,
        text: { truncationMode: "END", value: "hero band" },
      },
    });
    expect(sent[1]?.body.singleEmbeddingParams.embeddingPurpose).toBe("GENERIC_RETRIEVAL");
  });

  it("sends a picture as base64 PNG and cuts words at the model's limit", async () => {
    const { runtime, sent } = fake();
    const nova = createNovaMultimodalEmbeddings({ runtime });
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("not really a png"),
    ]);
    await nova.embedImages([png], "query");
    await nova.embedText(["x".repeat(9_000)]);
    expect(sent[0]?.body.singleEmbeddingParams).toMatchObject({
      embeddingPurpose: "GENERIC_RETRIEVAL",
      image: { format: "png", source: { bytes: png.toString("base64") } },
    });
    expect(sent[1]?.body.singleEmbeddingParams.text.value).toHaveLength(8_192);
  });

  it("refuses a vector of the wrong length", async () => {
    const nova = createNovaMultimodalEmbeddings({ runtime: fake(256).runtime });
    await expect(nova.embedText(["x"])).rejects.toThrow(/256 dimensions, need 1024/);
  });

  it("is chosen by EMBEDDING_PROVIDER, the hash embedder otherwise", () => {
    expect(loadMultimodalEmbeddings({ EMBEDDING_PROVIDER: "bedrock" }).model).toBe(
      NOVA_MULTIMODAL_EMBED,
    );
    expect(loadMultimodalEmbeddings({}).model).toBe(createHashMultimodalEmbeddings().model);
  });

  it("names a picture's format from its first bytes, so a screenshot may be a JPEG", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
    const png = Buffer.from("89504e470d0a1a0a00", "hex");
    expect([jpeg, webp, png, Buffer.from("GIF89a")].map(sniffImageFormat)).toEqual([
      "jpeg",
      "webp",
      "png",
      "gif",
    ]);
    expect(sniffImageFormat(Buffer.from("not an image"))).toBeUndefined();
    const { runtime, sent } = fake();
    const nova = createNovaMultimodalEmbeddings({ runtime });
    await nova.embedImages([jpeg], "query");
    expect(sent[0]?.body.singleEmbeddingParams.image.format).toBe("jpeg");
    await expect(nova.embedImages([Buffer.from("nope")])).rejects.toThrow(/not a PNG, JPEG/);
  });
});
