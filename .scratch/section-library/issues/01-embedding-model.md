# 01 · Pick the multimodal embedding model

Status: ready-for-human
Type: research
Blocked by: none

## What

Choose the Bedrock model that embeds both crops and text into one space at 1024 dimensions, as a `MultimodalEmbeddings` in `packages/library/src/embeddings.ts`.

Candidates: Amazon Nova Multimodal Embeddings, Cohere Embed v4, Titan Multimodal Embeddings G1.

To settle:

- which of them run in ap-south-1, and whether an `in.*`-style profile keeps the data in India (`config/models.json` separates these for chat models)
- 1024 dimensions supported, or what we give up to get there
- text-to-image quality: on 20 real crops with hand-written queries, does the right crop rank in the top 5 by text alone?
- price per image and per 1k text tokens

## Done when

- The choice and the numbers are recorded in `spec.md`'s Decisions.
- A Bedrock `MultimodalEmbeddings` exists, `embedText(texts)` and `embedImages(pngs)` both returning 1024-length unit vectors, selected from the environment; with nothing set, `createHashMultimodalEmbeddings` stays the default (it exists).
- Search crosses words and pictures with it (`crossModal`), and ticket 08's numbers say it helps.
