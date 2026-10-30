# 01 · Images in messages and tool results

Status: ready-for-agent
Type: task
Blocked by: 02

## What

Let an agent see images:

- **Contracts.** User messages can carry content parts: text and image references (`{ type: "image", artifact: "sha256-…" }`). Today `packages/contracts/src/messages.ts` allows plain strings only.
- **Model client.** When it builds a request, it turns image references into OpenAI-compatible `image_url` parts, sent as base64 data URLs read from the artifact store (02). Images never go out as public URLs.
- **Tool results with images.** A tool can return images next to its text. Chat Completions tool messages take text only, so the loop adds those images as a user message right after the tool result.
- **References, never bytes,** everywhere else: the saved transcript (`run_messages`), Valkey events, Langfuse spans and the redactor.
- **Usage** counts image input tokens where the provider reports them.

## Why

Any agent that compares, reads or checks visual material needs it. That includes Figma to DSL, and also screenshot checks, document reading and image QA. Without it the model is blind.

## Done when

- A scripted-model test sends a run with an image in the first message, and the model receives it as an image part with the bytes fetched from the store.
- A tool that returns an image gets it in front of the model on the next turn.
- The saved transcript and the events contain only references. A resumed run fetches the image again by id.

## Pointers

- `packages/contracts/src/messages.ts`, `packages/contracts/src/model.ts`
- `packages/core/src/model/openai-compatible.ts`, `packages/core/src/loop.ts`, `packages/core/src/tools.ts`
- `apps/worker/src/run-store.ts`, `packages/tracing`
