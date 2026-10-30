import { createBedrockClient, loadEnv, loadModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, createModelLessonWriter, loadEmbeddings } from "@dugout/memory";
import { loadTracing } from "@dugout/tracing";

/** The model that turns a reviewer's words into a lesson: a short rewrite, so the cheapest one. */
export const LESSON_MODEL = "nova-micro";

/** Real deps for CLI and API runs: .env, model client, Postgres-backed memory, lessons, tracing. */
export function liveDeps() {
  loadEnv();
  const models = loadModelConfig();
  const client = createBedrockClient({ models });
  const pool = createPool();
  const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
  const lessons = createModelLessonWriter(client, LESSON_MODEL);
  // undefined unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set
  const tracing = loadTracing();
  return { models, client, pool, store, lessons, tracing };
}
