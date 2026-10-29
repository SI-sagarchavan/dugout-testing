import { createOpenAICompatibleClient, loadEnv, loadModelConfig } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, createModelLessonWriter, loadEmbeddings } from "@dugout/memory";
import { loadTracing } from "@dugout/tracing";

/** Real deps for CLI and API runs: .env, model client, Postgres-backed memory, lessons, tracing. */
export function liveDeps(opts: { fast?: boolean } = {}) {
  loadEnv();
  const models = loadModelConfig();
  if (opts.fast) models.tiers.smart = models.tiers.fast;
  const client = createOpenAICompatibleClient(models);
  const pool = createPool();
  const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
  const lessons = createModelLessonWriter(client, models.tiers.fast.model);
  // undefined unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set
  const tracing = loadTracing();
  return { models, client, pool, store, lessons, tracing };
}
