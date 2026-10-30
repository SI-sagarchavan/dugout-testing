import { describe, expect, it } from "vitest";
import { createBedrockEmbeddings, EMBEDDING_DIMENSIONS, loadEmbeddings } from "../src/index.ts";

/** Stands in for the SDK client: records each InvokeModel body and answers with `dims` floats. */
function fakeRuntime(dims: number) {
  const bodies: unknown[] = [];
  const runtime = {
    async send(command: unknown) {
      const input = (command as { input: { modelId: string; body: string } }).input;
      bodies.push({ modelId: input.modelId, ...JSON.parse(input.body) });
      const embedding = new Array<number>(dims).fill(0.5);
      return { body: new TextEncoder().encode(JSON.stringify({ embedding })) };
    },
  };
  return { runtime, bodies };
}

describe("bedrock embeddings", () => {
  it("embeds each text with Titan V2 at 1024 dimensions", async () => {
    const { runtime, bodies } = fakeRuntime(EMBEDDING_DIMENSIONS);
    const vectors = await createBedrockEmbeddings({ runtime }).embed(["one", "two"]);
    expect(vectors.map((v) => v.length)).toEqual([1024, 1024]);
    expect(bodies).toEqual([
      {
        modelId: "amazon.titan-embed-text-v2:0",
        inputText: "one",
        dimensions: 1024,
        normalize: true,
      },
      {
        modelId: "amazon.titan-embed-text-v2:0",
        inputText: "two",
        dimensions: 1024,
        normalize: true,
      },
    ]);
  });

  it("refuses a vector of the wrong size", async () => {
    const { runtime } = fakeRuntime(1536);
    await expect(createBedrockEmbeddings({ runtime }).embed(["one"])).rejects.toThrow(
      "returned 1536 dimensions, need 1024",
    );
  });

  it("is chosen by EMBEDDING_PROVIDER=bedrock; with nothing set, the hash embedder", () => {
    expect(loadEmbeddings({ EMBEDDING_PROVIDER: "bedrock" }).model).toBe(
      "amazon.titan-embed-text-v2:0",
    );
    expect(loadEmbeddings({}).model).toBe("hash-v1");
    expect(() => loadEmbeddings({ EMBEDDING_PROVIDER: "titan" })).toThrow("EMBEDDING_PROVIDER");
  });
});
